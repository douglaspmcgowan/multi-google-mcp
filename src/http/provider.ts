import crypto from "node:crypto";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { EncryptedStore, sha256, type StoreState, type StoredClient, type TokenRecord } from "./store.js";

export const ACCESS_TTL_MS = 60 * 60 * 1000; // 1 h
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 d
export const CODE_TTL_MS = 5 * 60 * 1000;
export const PENDING_TTL_MS = 10 * 60 * 1000;
export const MAX_CLIENTS = 200;
/** An unapproved registration is dropped after this long. */
export const PENDING_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
/** Largest accepted client metadata document (JSON bytes). */
export const MAX_CLIENT_METADATA_BYTES = 4096;

/** Hosted Claude callbacks; loopback (any port) is allowed separately for Claude Code and tests. */
export const ALLOWED_REDIRECTS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];

/** True for an allowed redirect URI: an exact hosted Claude callback, or http loopback on any port. Pure. */
export function isAllowedRedirect(uri: string): boolean {
  if (ALLOWED_REDIRECTS.includes(uri)) return true;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1") && !u.username && !u.password && !u.hash;
}

/** Comma list -> lowercase set. Empty means nobody is allowed. Pure. */
export function parseAllowedEmails(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
}

/** One pending /authorize request, waiting for the Google sign-in to return. Held in memory only. */
export interface PendingAuthorization {
  clientId: string;
  clientName?: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
  googleVerifier: string;
  /** sha256 of the browser-binding cookie set at /authorize; the start and callback steps require it. */
  bindingHash: string;
  expiresAt: number;
}

/** Name of the HttpOnly cookie that binds a sign-in to the browser that started it. */
export const BINDING_COOKIE = "mg_auth";

/** True when the client has live (unexpired) access or refresh tokens. Pure. */
export function clientHasLiveTokens(s: StoreState, clientId: string, now: number): boolean {
  return [s.accessTokens, s.refreshTokens].some((bag) => Object.values(bag).some((t) => t.clientId === clientId && t.expiresAt > now));
}

/** Drops pending (unapproved) clients older than PENDING_CLIENT_TTL_MS. */
export function expirePendingClients(s: StoreState, now: number): void {
  for (const [id, c] of Object.entries(s.clients)) {
    if (!c.approved_at && (c.client_id_issued_at ?? 0) * 1000 + PENDING_CLIENT_TTL_MS <= now) delete s.clients[id];
  }
}

/** Marks a client approved. Returns false when it does not exist. */
export function approveClient(s: StoreState, clientId: string, now: number): boolean {
  const c = s.clients[clientId];
  if (!c) return false;
  c.approved_at = c.approved_at ?? Math.floor(now / 1000);
  return true;
}

/** Removes a client and every code and token issued to it. Returns false when it did not exist. */
export function revokeClient(s: StoreState, clientId: string): boolean {
  const existed = clientId in s.clients;
  delete s.clients[clientId];
  for (const bag of [s.codes, s.accessTokens, s.refreshTokens] as Array<Record<string, { clientId: string }>>) {
    for (const [k, v] of Object.entries(bag)) if (v.clientId === clientId) delete bag[k];
  }
  return existed;
}

export interface ProviderOptions {
  store: EncryptedStore;
  /** The MCP endpoint URL, e.g. https://host/mcp; tokens are bound to it. */
  resourceUrl: URL;
  allowedEmails: Set<string>;
  now?: () => number;
}

const rand = () => crypto.randomBytes(32).toString("base64url");

export class ConnectorOAuthProvider implements OAuthServerProvider {
  readonly pending = new Map<string, PendingAuthorization>();
  private readonly now: () => number;

  constructor(private readonly opts: ProviderOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    const store = this.opts.store;
    const now = this.now;
    return {
      getClient: (id: string) => store.data.clients[id] as OAuthClientInformationFull | undefined,
      registerClient: (client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) => {
        const full = client as OAuthClientInformationFull;
        const uris = full.redirect_uris ?? [];
        if (uris.length === 0 || !uris.every((u) => isAllowedRedirect(String(u)))) {
          throw new InvalidClientMetadataError(
            "redirect_uris must be https://claude.ai/api/mcp/auth_callback, https://claude.com/api/mcp/auth_callback, or an http loopback (localhost / 127.0.0.1) URI"
          );
        }
        if (Buffer.byteLength(JSON.stringify(full), "utf8") > MAX_CLIENT_METADATA_BYTES) {
          throw new InvalidClientMetadataError(`client metadata exceeds ${MAX_CLIENT_METADATA_BYTES} bytes`);
        }
        const id = full.client_id ?? crypto.randomUUID();
        const record: StoredClient = { ...(full as StoredClient), client_id: id, client_id_issued_at: full.client_id_issued_at ?? Math.floor(now() / 1000) };
        delete record.approved_at; // only the host CLI approves
        store.update((s) => {
          expirePendingClients(s, now());
          // Never evict: an approved client or one with live tokens is Douglas's connection.
          if (Object.keys(s.clients).length >= MAX_CLIENTS) {
            throw new ServerError("Client registration is full; remove clients on the host with npm run clients:revoke");
          }
          s.clients[id] = record;
        });
        return record;
      },
    };
  }

  private checkResource(resource: URL | string | undefined): string | undefined {
    if (resource === undefined) return undefined;
    const r = new URL(String(resource));
    const mine = this.opts.resourceUrl;
    const norm = (u: URL) => `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/$/, "")}`;
    if (norm(r) !== norm(mine)) throw new InvalidTargetError("resource does not identify this MCP server");
    return mine.href;
  }

  isEmailAllowed(email: string): boolean {
    return this.opts.allowedEmails.has(email.trim().toLowerCase());
  }

  /**
   * Pending client: a page saying it awaits approval on the host. Approved client: records the request,
   * sets the browser-binding cookie, and shows a consent page naming the client and its redirect host.
   */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const resource = this.checkResource(params.resource);
    const stored = this.opts.store.data.clients[client.client_id];
    if (!stored?.approved_at) return void this.pendingClientPage(stored ?? (client as StoredClient), res);
    this.sweepPending();
    const id = rand();
    const binding = rand();
    this.pending.set(id, {
      clientId: client.client_id,
      clientName: typeof client.client_name === "string" ? client.client_name : undefined,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? [],
      resource,
      googleVerifier: crypto.randomBytes(48).toString("base64url"),
      bindingHash: sha256(binding),
      expiresAt: this.now() + PENDING_TTL_MS,
    });
    const host = new URL(params.redirectUri).host;
    const name = escapeHtml(typeof client.client_name === "string" ? client.client_name : "An MCP client");
    res.cookie(BINDING_COOKIE, binding, {
      httpOnly: true,
      secure: this.opts.resourceUrl.protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: PENDING_TTL_MS,
    });
    page(res, 200)
      .set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'")
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<title>Connect multi-google</title></head><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
          `<h1>Connect multi-google</h1><p><strong>${name}</strong> wants access to your Google Workspace tools.</p>` +
          `<p>After sign-in you will be sent to <strong>${escapeHtml(host)}</strong>.</p>` +
          (host.startsWith("localhost") || host.startsWith("127.0.0.1")
            ? `<p><strong>Warning:</strong> this is a local address. Continue only if you started this sign-in yourself.</p>`
            : "") +
          `<form method="post" action="/oauth/google/start"><input type="hidden" name="request" value="${escapeHtml(id)}">` +
          `<button type="submit">Sign in with Google</button></form></body></html>`
      );
  }

  private pendingClientPage(client: StoredClient, res: Response): void {
    const issued = client.client_id_issued_at ? new Date(client.client_id_issued_at * 1000).toISOString() : "unknown";
    const name = escapeHtml(typeof client.client_name === "string" ? client.client_name : "An MCP client");
    const id = escapeHtml(client.client_id);
    page(res, 403).send(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>Awaiting approval</title></head><body style="font-family:system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem">` +
        `<h1>Awaiting approval on the host</h1><p><strong>${name}</strong> registered with this connector but is not approved yet.</p>` +
        `<p>Client id: <code>${id}</code><br>Registered: <code>${escapeHtml(issued)}</code></p>` +
        `<p>If you just added this connector yourself, approve it on the host, then connect again:</p>` +
        `<pre>npm run clients:approve -- ${id}</pre>` +
        `<p>If you did not, ignore this page; the registration expires in 24 hours.</p></body></html>`
    );
  }

  /** True when the request's binding cookie matches the pending request. */
  bindingMatches(p: PendingAuthorization, cookieValue: string | undefined): boolean {
    if (!cookieValue) return false;
    const a = Buffer.from(sha256(cookieValue), "hex");
    const b = Buffer.from(p.bindingHash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  takePending(id: string): PendingAuthorization | undefined {
    const p = this.pending.get(id);
    this.pending.delete(id);
    if (!p || p.expiresAt <= this.now()) return undefined;
    return p;
  }

  peekPending(id: string): PendingAuthorization | undefined {
    const p = this.pending.get(id);
    return p && p.expiresAt > this.now() ? p : undefined;
  }

  private sweepPending(): void {
    const t = this.now();
    for (const [k, v] of this.pending) if (v.expiresAt <= t) this.pending.delete(k);
    while (this.pending.size > 1000) this.pending.delete(this.pending.keys().next().value as string);
  }

  /** Issues an authorization code for a completed, allowed sign-in. Returns the raw code (stored hashed). */
  issueCode(p: PendingAuthorization, email: string): string {
    const code = rand();
    this.opts.store.update((s) => {
      this.opts.store.purge(this.now(), s);
      s.codes[sha256(code)] = {
        clientId: p.clientId,
        redirectUri: p.redirectUri,
        codeChallenge: p.codeChallenge,
        email: email.toLowerCase(),
        scopes: p.scopes,
        resource: p.resource,
        expiresAt: this.now() + CODE_TTL_MS,
      };
    });
    return code;
  }

  private codeRecord(client: OAuthClientInformationFull, code: string) {
    const rec = this.opts.store.data.codes[sha256(code)];
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt <= this.now()) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return rec;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.codeRecord(client, code).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const rec = this.codeRecord(client, code);
    if (!this.opts.store.data.clients[client.client_id]?.approved_at) throw new InvalidGrantError("Client is not approved");
    // Single use: consumed before any further check can fail.
    this.opts.store.update((s) => delete s.codes[sha256(code)]);
    if (redirectUri !== undefined && redirectUri !== rec.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    const res = resource ? this.checkResource(resource) : rec.resource;
    if (!this.isEmailAllowed(rec.email)) throw new InvalidGrantError("Account no longer allowed");
    return this.issueTokens(client.client_id, rec.email, rec.scopes, res, crypto.randomUUID());
  }

  private issueTokens(clientId: string, email: string, scopes: string[], resource: string | undefined, family: string): OAuthTokens {
    const access = rand();
    const refresh = rand();
    const now = this.now();
    const base: Omit<TokenRecord, "expiresAt"> = { clientId, email, scopes, resource, family };
    this.opts.store.update((s) => {
      this.opts.store.purge(now, s);
      s.accessTokens[sha256(access)] = { ...base, expiresAt: now + ACCESS_TTL_MS };
      s.refreshTokens[sha256(refresh)] = { ...base, expiresAt: now + REFRESH_TTL_MS };
    });
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_MS / 1000,
      refresh_token: refresh,
      ...(scopes.length ? { scope: scopes.join(" ") } : {}),
    };
  }

  private revokeFamily(family: string): void {
    this.opts.store.update((s) => {
      for (const bag of [s.accessTokens, s.refreshTokens]) {
        for (const [k, v] of Object.entries(bag)) if (v.family === family) delete bag[k];
      }
    });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const h = sha256(refreshToken);
    const s = this.opts.store.data;
    const used = s.usedRefreshTokens[h];
    if (used) {
      // Replay of a rotated token: assume theft and revoke the whole grant.
      this.revokeFamily(used.family);
      throw new InvalidGrantError("Refresh token already used");
    }
    const rec = s.refreshTokens[h];
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt <= this.now()) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    if (scopes && scopes.some((x) => !rec.scopes.includes(x))) throw new InvalidGrantError("Requested scope exceeds grant");
    const res = resource ? this.checkResource(resource) : rec.resource;
    this.opts.store.update((st) => {
      delete st.refreshTokens[h];
      st.usedRefreshTokens[h] = { family: rec.family, expiresAt: rec.expiresAt };
    });
    if (!this.isEmailAllowed(rec.email)) {
      this.revokeFamily(rec.family);
      throw new InvalidGrantError("Account no longer allowed");
    }
    return this.issueTokens(rec.clientId, rec.email, scopes ?? rec.scopes, res, rec.family);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rec = this.opts.store.data.accessTokens[sha256(token)];
    if (!rec) throw new InvalidTokenError("Invalid access token");
    if (rec.expiresAt <= this.now()) throw new InvalidTokenError("Token has expired");
    if (rec.resource && rec.resource !== this.opts.resourceUrl.href) throw new InvalidTokenError("Token not issued for this server");
    if (!this.isEmailAllowed(rec.email)) throw new InvalidTokenError("Account no longer allowed");
    if (!this.opts.store.data.clients[rec.clientId]?.approved_at) throw new InvalidTokenError("Client is no longer approved");
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: Math.floor(rec.expiresAt / 1000),
      resource: this.opts.resourceUrl,
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    // Revoking either token of a grant ends the whole grant (RFC 7009 2.1: SHOULD for refresh tokens).
    const h = sha256(request.token);
    const s = this.opts.store.data;
    const rec = s.accessTokens[h] ?? s.refreshTokens[h];
    if (rec && rec.clientId === client.client_id) this.revokeFamily(rec.family);
  }
}

function page(res: Response, status: number): Response {
  return res
    .status(status)
    .set("Content-Type", "text/html; charset=utf-8")
    .set("Cache-Control", "no-store")
    .set("X-Frame-Options", "DENY")
    .set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
