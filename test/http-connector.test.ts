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
import { createConnectorApp, fileAuditor, type GoogleSignIn } from "../src/http/app.js";
import { isAllowedRedirect } from "../src/http/provider.js";
import { setConfigBackend } from "../src/config.js";

const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mgm-http-"));
const auditFile = path.join(dir, "audit.log");
let clock = Date.now();
let googleEmail = "allowed@example.com";
const googleCalls: string[] = [];
const fakeGoogle: GoogleSignIn = {
  authUrl: ({ state }) => `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(state)}`,
  exchange: async ({ code }) => {
    googleCalls.push(code);
    return { email: googleEmail, emailVerified: true };
  },
};

let base = "";
let server: http.Server;
let store: EncryptedStore;

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
    allowedEmails: new Set(["allowed@example.com"]),
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

async function register(redirect = CLAUDE_CB) {
  return fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: "none", client_name: "Claude", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
}

/** Runs /authorize -> consent -> Google start -> Google callback. Returns the final redirect. */
async function signIn(clientId: string, challenge: string, redirect = CLAUDE_CB): Promise<URL> {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "st-1", resource: `${base}/mcp` });
  const consent = await fetch(`${base}/authorize?${q}`, { redirect: "manual" });
  assert.equal(consent.status, 200);
  const html = await consent.text();
  assert.ok(html.includes(new URL(redirect).host), "consent page names redirect host");
  const startPath = html.match(/href="(\/oauth\/google\/start\?request=[^"]+)"/)![1];
  const start = await fetch(base + startPath, { redirect: "manual" });
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const cb = await fetch(`${base}/oauth/google/callback?code=google-code&state=${encodeURIComponent(state)}`, { redirect: "manual" });
  assert.equal(cb.status, 302);
  return new URL(cb.headers.get("location")!);
}

async function token(body: Record<string, string>) {
  return fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
}

async function fullGrant() {
  const client = await (await register()).json();
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
  const client = await (await register()).json();
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
    const client = await (await register()).json();
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
  const client = await (await register()).json();
  const { verifier, challenge } = pkce();
  const code = (await signIn(client.client_id, challenge)).searchParams.get("code")!;
  const res = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, resource: "https://other.example/mcp" });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_target");
});
