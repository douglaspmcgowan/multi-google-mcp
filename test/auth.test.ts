import assert from "node:assert/strict";
import test from "node:test";
import { OAuth2Client } from "google-auth-library";
import { buildAuthUrl, routeAuthRequest, announceFlowStart, grantedShortNames, START_URL } from "../src/auth.js";
import { READ_ONLY_SCOPES, SCOPES } from "../src/config.js";

const client = new OAuth2Client("fake-client-id", "fake-secret", "http://localhost:3847/callback");

test("auth URL carries scopes, login_hint, offline access, forced consent, no include_granted_scopes", () => {
  const url = new URL(buildAuthUrl(client, { scopes: READ_ONLY_SCOPES, loginHint: "me@example.com" }));
  assert.equal(url.searchParams.get("login_hint"), "me@example.com");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.has("include_granted_scopes"), false);
  assert.deepEqual(url.searchParams.get("scope")!.split(" "), READ_ONLY_SCOPES);
  const noHint = new URL(buildAuthUrl(client, { scopes: SCOPES }));
  assert.equal(noHint.searchParams.has("login_hint"), false);
});

test("GET /start redirects to the authorization URL only with --no-open", () => {
  const authUrl = buildAuthUrl(client, { scopes: READ_ONLY_SCOPES, loginHint: "me@example.com" });
  const r = routeAuthRequest("/start", authUrl, true)!;
  assert.equal(r.status, 302);
  assert.equal(r.headers!.Location, authUrl);
  const target = new URL(r.headers!.Location);
  assert.equal(target.searchParams.get("login_hint"), "me@example.com");
  assert.equal(target.searchParams.has("include_granted_scopes"), false);
  assert.equal(routeAuthRequest("/start", authUrl, false)!.status, 404);
  assert.equal(routeAuthRequest("/other", authUrl, true)!.status, 404);
  assert.equal(routeAuthRequest("/callback", authUrl, true), undefined);
});

test("with --no-open nothing prints the URL and the browser opener is never called", () => {
  const authUrl = buildAuthUrl(client, { scopes: READ_ONLY_SCOPES });
  const out: string[] = [];
  let opened = 0;
  announceFlowStart({ authUrl, noOpen: true, log: (l) => out.push(l), opener: () => { opened++; } });
  const text = out.join("\n");
  assert.equal(opened, 0);
  assert.ok(text.includes(START_URL));
  assert.ok(!text.includes("accounts.google.com"));
  assert.ok(!text.includes("client_id"));
  assert.ok(!text.includes(authUrl));
});

test("without --no-open the URL is printed and the opener is called", () => {
  const authUrl = buildAuthUrl(client, { scopes: SCOPES });
  const out: string[] = [];
  const opened: string[] = [];
  announceFlowStart({ authUrl, noOpen: false, log: (l) => out.push(l), opener: (u) => opened.push(u) });
  assert.ok(out.join("\n").includes(authUrl));
  assert.deepEqual(opened, [authUrl]);
});

test("granted scopes are reported by short name", () => {
  assert.deepEqual(
    grantedShortNames("https://www.googleapis.com/auth/drive.readonly openid"),
    ["drive.readonly", "openid"]
  );
  assert.deepEqual(grantedShortNames(undefined), []);
});
