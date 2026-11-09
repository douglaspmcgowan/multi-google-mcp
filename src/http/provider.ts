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
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { EncryptedStore, sha256, type TokenRecord } from "./store.js";

export const ACCESS_TTL_MS = 60 * 60 * 1000; // 1 h
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 d
export const CODE_TTL_MS = 5 * 60 * 1000;
export const PENDING_TTL_MS = 10 * 60 * 1000;
export const MAX_CLIENTS = 200;

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
  expiresAt: number;
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
        const id = full.client_id ?? crypto.randomUUID();
        const record = { ...full, client_id: id, client_id_issued_at: full.client_id_issued_at ?? Math.floor(now() / 1000) };
        store.update((s) => {
          const ids = Object.keys(s.clients);
          if (ids.length >= MAX_CLIENTS) {
            // Evict the oldest registration; DCR clients re-register on a fresh connection.
            ids.sort((a, b) => (s.clients[a].client_id_issued_at ?? 0) - (s.clients[b].client_id_issued_at ?? 0));
            delete s.clients[ids[0]];
          }
          s.clients[id] = record as never;
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

  /** Records the request and shows a consent page naming the client and its redirect host. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const resource = this.checkResource(params.resource);
    this.sweepPending();
    const id = rand();
    this.pending.set(id, {
      clientId: client.client_id,
      clientName: typeof client.client_name === "string" ? client.client_name : undefined,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? [],
      resource,
      googleVerifier: crypto.randomBytes(48).toString("base64url"),
      expiresAt: this.now() + PENDING_TTL_MS,
    });
    const host = new URL(params.redirectUri).host;
    const name = escapeHtml(typeof client.client_name === "string" ? client.client_name : "An MCP client");
    res
      .status(200)
      .set("Content-Type", "text/html; charset=utf-8")
      .set("X-Frame-Options", "DENY")
      .set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<title>Connect multi-google</title></head><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
          `<h1>Connect multi-google</h1><p><strong>${name}</strong> wants access to your Google Workspace tools.</p>` +
          `<p>After sign-in you will be sent to <strong>${escapeHtml(host)}</strong>.</p>` +
          (host.startsWith("localhost") || host.startsWith("127.0.0.1")
            ? `<p><strong>Warning:</strong> this is a local address. Continue only if you started this sign-in yourself.</p>`
            : "") +
          `<p><a href="/oauth/google/start?request=${encodeURIComponent(id)}">Sign in with Google</a></p></body></html>`
      );
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
      this.opts.store.purge(this.now());
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
      this.opts.store.purge(now);
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
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: Math.floor(rec.expiresAt / 1000),
      resource: this.opts.resourceUrl,
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const h = sha256(request.token);
    this.opts.store.update((s) => {
      for (const bag of [s.accessTokens, s.refreshTokens]) {
        const rec = bag[h];
        if (rec && rec.clientId === client.client_id) delete bag[h];
      }
    });
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
