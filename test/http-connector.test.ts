import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EncryptedStore } from "../src/http/store.js";
import { createConnectorApp, fileAuditor, googleSignIn } from "../src/http/app.js";
import { approveClient, isAllowedRedirect, MAX_CLIENTS, PENDING_CLIENT_TTL_MS } from "../src/http/provider.js";
import { setConfigBackend } from "../src/config.js";
import { OAuth2Client } from "google-auth-library";

const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mgm-http-"));
const auditFile = path.join(dir, "audit.log");
let clock = Date.now();
let googleEmail = "allowed@example.com";
// Google's signing key is a local RSA key; the sign-in client verifies real ID-token signatures against it offline.
const { privateKey: googleKey, publicKey: googlePublic } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const GOOGLE_KID = "test-kid";
const SIGNIN_CLIENT = "fixture-signin.apps.googleusercontent.com";
const fakeGoogle = googleSignIn(SIGNIN_CLIENT, (id) => {
  const c = new OAuth2Client(id);
  (c as any).getFederatedSignonCertsAsync = async () => ({ certs: { [GOOGLE_KID]: googlePublic.export({ type: "spki", format: "pem" }).toString() } });
  return c;
});

/** A Google ID token signed by the test key: aud = sign-in client, iss = Google, the nonce Google echoes. */
function idToken(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "RS256", typ: "JWT", kid: GOOGLE_KID });
  const body = b64(claims);
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), googleKey).toString("base64url");
  return `${head}.${body}.${sig}`;
}
const nowSec = () => Math.floor(Date.now() / 1000);
/** The ID token Google would return for a sign-in that echoes `nonce`. */
const tokenFor = (nonce: string, claims: Record<string, unknown> = {}) =>
  idToken({ iss: "https://accounts.google.com", aud: SIGNIN_CLIENT, sub: "1", email: googleEmail, email_verified: true, nonce, iat: nowSec() - 10, exp: nowSec() + 600, ...claims });

let base = "";
let server: http.Server;
let store: EncryptedStore;
const allowed = new Set(["allowed@example.com"]);

test.before(async () => {
  server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  store = EncryptedStore.open(path.join(dir, "store.enc"), { MULTI_GOOGLE_STORE_KEY: crypto.randomBytes(32).toString("base64") });
  store.update((s) => {
    s.google = {
      clientId: "fixture-client",
      clientSecret: "fixture-secret",
      accounts: { work: { access_token: null, refresh_token: "1//fixture-google-refresh", token_type: "Bearer", expiry_date: null, scope: "" } },
    };
  });
  const { app } = createConnectorApp({
    store,
    publicBaseUrl: base,
    allowedEmails: allowed,
    signInClientId: SIGNIN_CLIENT,
    google: fakeGoogle,
    audit: fileAuditor(auditFile),
    now: () => clock,
  });
  server.on("request", app);
});

test.after(() => {
  setConfigBackend(undefined);
  server.close();
});

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
};

// Each registration comes from its own forwarded client IP (as Tailscale Funnel sets it), so the SDK's
// per-IP DCR limit (20/h) does not trip across tests; the limiter test below pins one IP on purpose.
let ipCounter = 0;
const nextIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`;

async function register(redirect = CLAUDE_CB, ip = nextIp()) {
  return fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: "none", client_name: "Claude", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
}

/** Registers and approves on the host, like Douglas running npm run clients:approve. */
async function approvedClient(redirect = CLAUDE_CB) {
  const client = await (await register(redirect)).json();
  store.update((s) => approveClient(s, client.client_id, clock));
  return client;
}

const authorizeQuery = (clientId: string, challenge: string, redirect = CLAUDE_CB) =>
  new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "st-1", resource: `${base}/mcp` });

/** /authorize -> consent page. Returns the request id and the binding cookie (name=value). */
async function consent(clientId: string, challenge: string, redirect = CLAUDE_CB) {
  const res = await fetch(`${base}/authorize?${authorizeQuery(clientId, challenge, redirect)}`, { redirect: "manual" });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes(new URL(redirect).host), "consent page names redirect host");
  const setCookie = res.headers.get("set-cookie")!;
  assert.match(setCookie, /mg_auth=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=None/i);
  assert.match(setCookie, /Secure/i);
  const request = html.match(/name="request" value="([^"]+)"/)![1];
  return { request, cookie: setCookie.split(";")[0] };
}

const startPost = (request: string, cookie?: string) =>
  fetch(`${base}/oauth/google/start`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams({ request }),
  });

/** The Google authorization URL the start step redirects to: its state and nonce. */
function googleParams(start: Response) {
  const u = new URL(start.headers.get("location")!);
  assert.equal(u.origin, "https://accounts.google.com");
  assert.equal(u.searchParams.get("response_mode"), "form_post");
  return { state: u.searchParams.get("state")!, nonce: u.searchParams.get("nonce")! };
}

/** Google's form_post return: a cross-site POST carrying the ID token and the state. */
const callback = (state: string, cookie: string | undefined, id_token: string) =>
  fetch(`${base}/oauth/google/callback`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams({ state, id_token }),
  });

/** Runs /authorize -> consent POST -> Google start -> Google form_post callback. Returns the final redirect. */
async function signIn(clientId: string, challenge: string, redirect = CLAUDE_CB): Promise<URL> {
  const { request, cookie } = await consent(clientId, challenge, redirect);
  const start = await startPost(request, cookie);
  assert.equal(start.status, 303);
  const { state, nonce } = googleParams(start);
  const cb = await callback(state, cookie, tokenFor(nonce));
  assert.equal(cb.status, 302);
  return new URL(cb.headers.get("location")!);
}

async function token(body: Record<string, string>) {
  return fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
}

async function fullGrant() {
  const client = await approvedClient();
  const { verifier, challenge } = pkce();
  const back = await signIn(client.client_id, challenge);
  const code = back.searchParams.get("code")!;
  const res = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CLAUDE_CB, resource: `${base}/mcp` });
  assert.equal(res.status, 200);
  return { client, tokens: await res.json() };
}

test("unauthenticated /mcp returns 401 with resource_metadata", async () => {
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate")!, new RegExp(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`));
});

test("metadata endpoints have the required shape", async () => {
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${base}/mcp`);
  assert.deepEqual(prm.authorization_servers, [`${base}/`]);
  const root = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
  assert.equal(root.resource, `${base}/mcp`);
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(new URL(as.issuer).origin, base);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  for (const k of ["authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint"]) assert.ok(as[k]?.startsWith(base), k);
  assert.ok(as.grant_types_supported.includes("refresh_token"));
});

test("DCR rejects non-allowlisted redirect URIs and accepts Claude and loopback", async () => {
  for (const bad of ["https://evil.example/cb", "https://claude.ai/other", "http://10.0.0.1/cb", "https://localhost/cb"]) {
    const r = await register(bad);
    assert.equal(r.status, 400, bad);
    assert.equal((await r.json()).error, "invalid_client_metadata");
  }
  assert.equal((await register(CLAUDE_CB)).status, 201);
  assert.equal((await register("https://claude.com/api/mcp/auth_callback")).status, 201);
  assert.equal((await register("http://localhost:3118/callback")).status, 201);
  assert.ok(isAllowedRedirect("http://127.0.0.1:55555/callback"));
});

test("PKCE is required (missing or plain challenge refused)", async () => {
  const client = await approvedClient();
  const noPkce = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: CLAUDE_CB });
  const r1 = await fetch(`${base}/authorize?${noPkce}`, { redirect: "manual" });
  assert.equal(r1.status, 302);
  assert.equal(new URL(r1.headers.get("location")!).searchParams.get("error"), "invalid_request");
  noPkce.set("code_challenge", "abc");
  noPkce.set("code_challenge_method", "plain");
  const r2 = await fetch(`${base}/authorize?${noPkce}`, { redirect: "manual" });
  assert.equal(new URL(r2.headers.get("location")!).searchParams.get("error"), "invalid_request");
  // A wrong verifier at /token is refused.
  const { challenge } = pkce();
  const code = (await signIn(client.client_id, challenge)).searchParams.get("code")!;
  const bad = await token({ grant_type: "authorization_code", code, code_verifier: pkce().verifier, client_id: client.client_id });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "invalid_grant");
});

test("a disallowed Google email gets no code", async () => {
  googleEmail = "stranger@example.com";
  try {
    const client = await approvedClient();
    const back = await signIn(client.client_id, pkce().challenge);
    assert.equal(back.searchParams.get("error"), "access_denied");
    assert.equal(back.searchParams.get("code"), null);
    assert.equal(back.searchParams.get("state"), "st-1");
  } finally {
    googleEmail = "allowed@example.com";
  }
});

test("allowed email completes code -> token -> tools/list over Streamable HTTP", async () => {
  const { tokens } = await fullGrant();
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.expires_in, 3600);
  assert.ok(tokens.access_token.length >= 43 && tokens.refresh_token.length >= 43);
  // Only hashes are stored.
  assert.ok(!JSON.stringify(store.data).includes(tokens.access_token));
  assert.ok(!fs.readFileSync(store.file, "utf8").includes(tokens.access_token));
  const client = new Client({ name: "test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.length >= 190, `tools: ${tools.length}`);
  assert.ok(tools.some((t) => t.name === "google_list_accounts"));
  assert.ok(tools.some((t) => t.name === "gmail_search"));
  const accounts = await client.callTool({ name: "google_list_accounts", arguments: {} });
  assert.match((accounts.content as any)[0].text, /work/);

  // Local-disk tools: refused, nothing written.
  const target = path.join(dir, "should-not-exist.bin");
  const dl = await client.callTool({ name: "drive_download", arguments: { account: "work", file_id: "x", destination_path: target } });
  assert.equal(dl.isError, true);
  assert.match((dl.content as any)[0].text, /Refused/);
  assert.equal(fs.existsSync(target), false);
  const thumbDir = path.join(dir, "thumbs");
  const th = await client.callTool({ name: "slides_save_thumbnail", arguments: { account: "work", presentation_id: "p", slide_id: "s", destination_path: path.join(thumbDir, "a.png") } });
  assert.equal(th.isError, true);
  assert.equal(fs.existsSync(thumbDir), false);
  await client.close();

  // Audit: one line per call, no arguments.
  const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const dlLine = lines.find((l) => l.tool === "drive_download");
  assert.deepEqual(Object.keys(dlLine).sort(), ["account", "ok", "time", "tool"]);
  assert.equal(dlLine.account, "work");
  assert.equal(dlLine.ok, false);
  assert.ok(!fs.readFileSync(auditFile, "utf8").includes(target));
});

test("refresh rotates and invalidates the old refresh token; replay revokes the grant", async () => {
  const { client, tokens } = await fullGrant();
  const r1 = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(r1.status, 200);
  const t2 = await r1.json();
  assert.notEqual(t2.refresh_token, tokens.refresh_token);
  const replay = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, "invalid_grant");
  // The replay revoked the rotated family too.
  const r3 = await token({ grant_type: "refresh_token", refresh_token: t2.refresh_token, client_id: client.client_id });
  assert.equal(r3.status, 400);
});

test("expired access token is refused with 401", async () => {
  const { tokens } = await fullGrant();
  const call = () => fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal((await call()).status, 200);
  clock += 61 * 60 * 1000;
  try {
    const res = await call();
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate")!, /invalid_token/);
  } finally {
    clock -= 61 * 60 * 1000;
  }
});

test("revoked access token is refused", async () => {
  const { client, tokens } = await fullGrant();
  const rv = await fetch(`${base}/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: tokens.access_token, client_id: client.client_id }) });
  assert.equal(rv.status, 200);
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
});

test("a token for another resource is refused at /token", async () => {
  const client = await approvedClient();
  const { verifier, challenge } = pkce();
  const code = (await signIn(client.client_id, challenge)).searchParams.get("code")!;
  const res = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, resource: "https://other.example/mcp" });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_target");
});

async function codeFor(client: { client_id: string }) {
  const { verifier, challenge } = pkce();
  const code = (await signIn(client.client_id, challenge)).searchParams.get("code")!;
  assert.ok(code);
  return { code, verifier };
}

test("an authorization code works once; the second exchange fails", async () => {
  const client = await approvedClient();
  const { code, verifier } = await codeFor(client);
  const body = { grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CLAUDE_CB };
  assert.equal((await token(body)).status, 200);
  const again = await token(body);
  assert.equal(again.status, 400);
  assert.equal((await again.json()).error, "invalid_grant");
});

test("redirect_uri mismatch at /token fails and burns the code", async () => {
  const client = await approvedClient();
  const { code, verifier } = await codeFor(client);
  const bad = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: "https://claude.com/api/mcp/auth_callback" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "invalid_grant");
  const retry = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CLAUDE_CB });
  assert.equal(retry.status, 400);
});

test("an email removed from ALLOWED_EMAILS after a grant is refused at /mcp and at refresh", async () => {
  const { client, tokens } = await fullGrant();
  allowed.delete("allowed@example.com");
  try {
    const call = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(call.status, 401);
    const r = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, "invalid_grant");
  } finally {
    allowed.add("allowed@example.com");
  }
});

test("unknown or expired state at the Google callback is refused without a redirect", async () => {
  const unknown = await callback("no-such-request", "mg_auth=whatever", tokenFor("n"));
  assert.equal(unknown.status, 400);
  assert.equal(unknown.headers.get("location"), null);
  const client = await approvedClient();
  const { request, cookie } = await consent(client.client_id, pkce().challenge);
  const start = await startPost(request, cookie);
  const { state, nonce } = googleParams(start);
  clock += 11 * 60 * 1000;
  try {
    const late = await callback(state, cookie, tokenFor(nonce));
    assert.equal(late.status, 400);
    assert.equal(late.headers.get("location"), null);
  } finally {
    clock -= 11 * 60 * 1000;
  }
});

test("a missing or mismatched browser-binding cookie is refused at start and callback", async () => {
  const client = await approvedClient();
  const { request, cookie } = await consent(client.client_id, pkce().challenge);
  // Start: no cookie, wrong cookie, and GET (the old link form) all refused.
  assert.equal((await startPost(request)).status, 400);
  assert.equal((await startPost(request, "mg_auth=forged")).status, 400);
  const get = await fetch(`${base}/oauth/google/start?request=${encodeURIComponent(request)}`, { redirect: "manual" });
  assert.equal(get.status, 405);
  // Callback: the victim's browser has no matching cookie -> no code, no redirect; the request survives.
  const start = await startPost(request, cookie);
  assert.equal(start.status, 303);
  const { state, nonce } = googleParams(start);
  const other = await callback(state, "mg_auth=someone-else", tokenFor(nonce));
  assert.equal(other.status, 400);
  assert.equal(other.headers.get("location"), null);
  assert.equal((await callback(state, undefined, tokenFor(nonce))).status, 400);
  const ok = await callback(state, cookie, tokenFor(nonce));
  assert.equal(ok.status, 302);
  assert.ok(new URL(ok.headers.get("location")!).searchParams.get("code"));
});

test("a GET to the callback does not complete sign-in; the POST still does", async () => {
  const client = await approvedClient();
  const { request, cookie } = await consent(client.client_id, pkce().challenge);
  const start = await startPost(request, cookie);
  const { state, nonce } = googleParams(start);
  const get = await fetch(`${base}/oauth/google/callback?state=${encodeURIComponent(state)}&id_token=${tokenFor(nonce)}`, { redirect: "manual", headers: { cookie } });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("location"), null);
  // The GET consumed nothing: the POST with the same state and cookie completes.
  const ok = await callback(state, cookie, tokenFor(nonce));
  assert.equal(ok.status, 302);
  assert.ok(new URL(ok.headers.get("location")!).searchParams.get("code"));
});

test("a nonce that does not match the request is refused without a code", async () => {
  const client = await approvedClient();
  const { request, cookie } = await consent(client.client_id, pkce().challenge);
  const start = await startPost(request, cookie);
  const { state } = googleParams(start);
  const bad = await callback(state, cookie, tokenFor("some-other-nonce"));
  assert.equal(bad.status, 302);
  const back = new URL(bad.headers.get("location")!);
  assert.equal(back.searchParams.get("error"), "access_denied");
  assert.equal(back.searchParams.get("code"), null);
  assert.equal(back.searchParams.get("state"), "st-1");
  // The mismatched attempt used up the request: the right nonce now finds nothing.
  const { nonce } = googleParams(start);
  assert.equal((await callback(state, cookie, tokenFor(nonce))).status, 400);
});

test("an ID token with email_verified false or the wrong audience gets no code", async () => {
  const client = await approvedClient();
  const unverified = await consent(client.client_id, pkce().challenge);
  const s1 = await startPost(unverified.request, unverified.cookie);
  const p1 = googleParams(s1);
  const r1 = await callback(p1.state, unverified.cookie, tokenFor(p1.nonce, { email_verified: false }));
  assert.equal(new URL(r1.headers.get("location")!).searchParams.get("error"), "access_denied");
  assert.equal(new URL(r1.headers.get("location")!).searchParams.get("code"), null);

  const wrongAud = await consent(client.client_id, pkce().challenge);
  const s2 = await startPost(wrongAud.request, wrongAud.cookie);
  const p2 = googleParams(s2);
  const r2 = await callback(p2.state, wrongAud.cookie, tokenFor(p2.nonce, { aud: "someone-else.apps.googleusercontent.com" }));
  assert.equal(r2.status, 302);
  assert.equal(new URL(r2.headers.get("location")!).searchParams.get("error"), "server_error");
  assert.equal(new URL(r2.headers.get("location")!).searchParams.get("code"), null);
});

test("a replayed sign-in (same state, same ID token) is refused after the first completes", async () => {
  const client = await approvedClient();
  const { request, cookie } = await consent(client.client_id, pkce().challenge);
  const start = await startPost(request, cookie);
  const { state, nonce } = googleParams(start);
  const token = tokenFor(nonce);
  const first = await callback(state, cookie, token);
  assert.equal(first.status, 302);
  assert.ok(new URL(first.headers.get("location")!).searchParams.get("code"));
  const replay = await callback(state, cookie, token);
  assert.equal(replay.status, 400);
  assert.equal(replay.headers.get("location"), null);
});

test("a pending client gets an approval page and no code; once approved it signs in", async () => {
  const client = await (await register()).json();
  const { challenge } = pkce();
  const res = await fetch(`${base}/authorize?${authorizeQuery(client.client_id, challenge)}`, { redirect: "manual" });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("set-cookie"), null);
  const html = await res.text();
  assert.match(html, /Awaiting approval on the host/);
  assert.ok(html.includes(client.client_id));
  assert.ok(html.includes(new Date(client.client_id_issued_at * 1000).toISOString()));
  assert.ok(!html.includes("oauth/google/start"));
  store.update((s) => approveClient(s, client.client_id, clock));
  const back = await signIn(client.client_id, challenge);
  assert.ok(back.searchParams.get("code"));
});

test("DCR never evicts: full registry refuses; approved clients survive; pending ones expire after 24 h", async () => {
  const saved = structuredClone(store.data.clients);
  try {
    const approved = await approvedClient();
    store.update((s) => {
      for (let i = Object.keys(s.clients).length; i < MAX_CLIENTS; i++) {
        s.clients[`filler-${i}`] = { client_id: `filler-${i}`, client_id_issued_at: Math.floor(clock / 1000), redirect_uris: [CLAUDE_CB] };
      }
    });
    const full = await register();
    assert.equal(full.status, 500);
    assert.ok(store.data.clients[approved.client_id], "approved client kept");
    // 24 h later the pending fillers expire and registration opens again; the approved client stays.
    clock += PENDING_CLIENT_TTL_MS + 1000;
    try {
      assert.equal((await register()).status, 201);
      assert.ok(store.data.clients[approved.client_id]);
      assert.equal(Object.keys(store.data.clients).some((k) => k.startsWith("filler-")), false);
    } finally {
      clock -= PENDING_CLIENT_TTL_MS + 1000;
    }
  } finally {
    store.update((s) => void (s.clients = saved));
  }
});

test("oversized client metadata is refused", async () => {
  const r = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": nextIp() },
    body: JSON.stringify({ redirect_uris: [CLAUDE_CB], token_endpoint_auth_method: "none", client_name: "x".repeat(5000) }),
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "invalid_client_metadata");
});

test("revoking a refresh token ends its access tokens too", async () => {
  const { client, tokens } = await fullGrant();
  const rv = await fetch(`${base}/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: tokens.refresh_token, client_id: client.client_id }) });
  assert.equal(rv.status, 200);
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
});

test("rate limits key on the forwarded client IP from the loopback proxy", async () => {
  const saved = structuredClone(store.data.clients);
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await register(CLAUDE_CB, "198.51.100.7")).status);
    assert.equal(statuses.filter((x) => x === 201).length, 20);
    assert.equal(statuses[20], 429);
    // Another public client behind the same Funnel is not affected.
    assert.equal((await register(CLAUDE_CB, "198.51.100.8")).status, 201);
  } finally {
    store.update((s) => void (s.clients = saved));
  }
});
