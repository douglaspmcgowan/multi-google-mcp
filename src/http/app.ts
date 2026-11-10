import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import { rateLimit } from "express-rate-limit";
import { OAuth2Client } from "google-auth-library";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createMcpServer } from "../server.js";
import { setConfigBackend } from "../config.js";
import { EncryptedStore } from "./store.js";
import { BINDING_COOKIE, BINDING_COOKIE_OPTIONS, ConnectorOAuthProvider, escapeHtml, type GoogleIdentity } from "./provider.js";

/** A verified ID token: who signed in, whether Google verified the address, and the nonce it echoes. */
export interface VerifiedIdentity extends GoogleIdentity {
  nonce?: string;
}

/** The Google half of the sign-in: an auth URL (implicit ID-token flow) and an ID-token verifier. */
export interface GoogleSignIn {
  authUrl(opts: { state: string; nonce: string; redirectUri: string }): string;
  verify(opts: { idToken: string }): Promise<VerifiedIdentity>;
}

export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

/**
 * Google sign-in through a Web application client that holds no secret: OpenID Connect implicit flow
 * (response_type=id_token, response_mode=form_post, scope openid email, nonce). The ID token is verified by
 * google-auth-library (signature against Google's certs, aud = the sign-in client id, iss = Google, exp).
 * The Desktop client in the store is never used here; it only makes account API calls.
 * `makeClient` exists for tests (stubbed certs).
 */
export function googleSignIn(signInClientId: string, makeClient: (clientId: string) => OAuth2Client = (id) => new OAuth2Client(id)): GoogleSignIn {
  if (!signInClientId) throw new Error("MULTI_GOOGLE_SIGNIN_CLIENT_ID is not set (the Google Web client id used for connector sign-in)");
  return {
    authUrl: ({ state, nonce, redirectUri }) =>
      `${GOOGLE_AUTH_ENDPOINT}?${new URLSearchParams({
        client_id: signInClientId,
        redirect_uri: redirectUri,
        response_type: "id_token",
        response_mode: "form_post",
        scope: "openid email",
        state,
        nonce,
        prompt: "select_account",
      })}`,
    verify: async ({ idToken }) => {
      const ticket = await makeClient(signInClientId).verifyIdToken({ idToken, audience: signInClientId });
      const p = ticket.getPayload();
      return { email: String(p?.email ?? ""), emailVerified: p?.email_verified === true, nonce: p?.nonce };
    },
  };
}

/** One cookie value from a Cookie header, or undefined. Pure. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export interface AuditEntry {
  tool: string;
  account: string | null;
  ok: boolean;
}

/** Appends one JSON line per tool call: time, tool, account alias, ok. Never arguments or content. */
export function fileAuditor(file: string): (e: AuditEntry) => void {
  return (e) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), tool: e.tool, account: e.account, ok: e.ok }) + "\n", { mode: 0o600 });
    } catch {
      /* auditing must never break a call */
    }
  };
}

export interface ConnectorAppOptions {
  store: EncryptedStore;
  publicBaseUrl: string;
  allowedEmails: Set<string>;
  /** Google Web client id for sign-in (MULTI_GOOGLE_SIGNIN_CLIENT_ID). */
  signInClientId: string;
  google?: GoogleSignIn;
  audit: (e: AuditEntry) => void;
  now?: () => number;
}

export function createConnectorApp(opts: ConnectorAppOptions) {
  const base = new URL(opts.publicBaseUrl.replace(/\/+$/, "") + "/");
  const issuer = new URL(base.origin + base.pathname.replace(/\/$/, ""));
  const resourceUrl = new URL("mcp", base);
  const googleCallback = new URL("oauth/google/callback", base).href;
  const store = opts.store;
  const google = opts.google ?? googleSignIn(opts.signInClientId);

  // Tools read Google tokens from the encrypted store, never from config.json.
  setConfigBackend({
    load: () => structuredClone(store.data.google),
    save: (c) => store.update((s) => void (s.google = c)),
  });

  const provider = new ConnectorOAuthProvider({ store, resourceUrl, allowedEmails: opts.allowedEmails, now: opts.now });
  const app = express();
  app.disable("x-powered-by");
  // Tailscale serve/Funnel proxies from loopback and *sets* X-Forwarded-For to the public client IP
  // (tailscale ipn/ipnlocal/serve.go addProxyForwardedHeaders). Trusting only loopback makes req.ip, which
  // every rate limiter here keys on, that client IP; a non-loopback peer's X-Forwarded-For is ignored.
  app.set("trust proxy", "loopback");

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: issuer,
      resourceServerUrl: resourceUrl,
      resourceName: "multi-google",
      scopesSupported: [],
    })
  );
  // Some clients probe the root path too.
  const prm = {
    resource: resourceUrl.href,
    authorization_servers: [issuer.href],
    resource_name: "multi-google",
  };
  app.get("/.well-known/oauth-protected-resource", (_req, res) => void res.json(prm));

  const googleLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });

  const expired = (res: Response) => void res.status(400).type("text/plain").send("This sign-in request expired. Start again from Claude.");
  const unbound = (res: Response) =>
    void res.status(400).type("text/plain").send("This sign-in was not started in this browser. Start again from Claude.");
  const cookieOf = (req: Request) => readCookie(req.headers.cookie, BINDING_COOKIE);

  // Consent is a POST from the consent page; the binding cookie must match the pending request.
  app.post("/oauth/google/start", googleLimiter, express.urlencoded({ extended: false, limit: "4kb" }), (req: Request, res: Response) => {
    const id = String(req.body?.request ?? "");
    const p = provider.peekPending(id);
    if (!p) return expired(res);
    if (!provider.bindingMatches(p, cookieOf(req))) return unbound(res);
    res.redirect(303, google.authUrl({ state: id, nonce: p.googleNonce, redirectUri: googleCallback }));
  });
  app.all("/oauth/google/start", (_req, res) => void res.status(405).set("Allow", "POST").type("text/plain").send("Use the consent page."));

  // Google returns here by form_post (a cross-site POST carrying the id_token and state). Only POST completes sign-in.
  app.post("/oauth/google/callback", googleLimiter, express.urlencoded({ extended: false, limit: "64kb" }), async (req: Request, res: Response) => {
    const id = String(req.body?.state ?? "");
    const peeked = provider.peekPending(id);
    if (!peeked) return expired(res);
    if (!provider.bindingMatches(peeked, cookieOf(req))) return unbound(res);
    const p = provider.takePending(id);
    if (!p) return expired(res);
    res.clearCookie(BINDING_COOKIE, BINDING_COOKIE_OPTIONS);
    const back = (params: Record<string, string>) => {
      const u = new URL(p.redirectUri);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (p.state) u.searchParams.set("state", p.state);
      res.redirect(302, u.href);
    };
    const idToken = typeof req.body?.id_token === "string" ? req.body.id_token : "";
    if (req.body?.error || !idToken) return back({ error: "access_denied", error_description: "Google sign-in was cancelled" });
    let who: VerifiedIdentity;
    try {
      who = await google.verify({ idToken });
    } catch {
      return back({ error: "server_error", error_description: "Google sign-in failed" });
    }
    if (who.nonce !== p.googleNonce) {
      return back({ error: "access_denied", error_description: "Google sign-in could not be verified" });
    }
    if (!who.emailVerified || !provider.isEmailAllowed(who.email)) {
      return back({ error: "access_denied", error_description: "This Google account is not allowed" });
    }
    back({ code: provider.issueCode(p, who.email) });
  });
  // Any other method on the callback (a GET from a pasted or replayed link) completes nothing.
  app.all("/oauth/google/callback", (_req, res) => void res.status(405).set("Allow", "POST").type("text/plain").send("Google returns here by POST; start sign-in from Claude."));

  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
  });

  app.all("/mcp", bearer, express.json({ limit: "4mb" }), async (req: Request, res: Response) => {
    if (req.method !== "POST") {
      return void res
        .status(405)
        .set("Allow", "POST")
        .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
    }
    // Stateless: a fresh server and transport per request, so no session can be hijacked or leak state.
    const server = createMcpServer({ remote: { audit: opts.audit } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });

  app.get("/", (_req, res) => void res.type("text/html").send(`<!doctype html><title>multi-google</title><p>multi-google MCP connector. Endpoint: ${escapeHtml(resourceUrl.href)}</p>`));

  // Last-resort handler: never echo request data or stacks.
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (!res.headersSent) res.status(500).json({ error: "server_error" });
  });

  return { app, provider, resourceUrl, issuer };
}
