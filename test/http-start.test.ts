import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_HTTP_PORT, resolveHttpSettings, startHttp } from "../src/http/start.js";

const SIGNIN = "fixture-signin.apps.googleusercontent.com";

test("connector reads only MULTI_GOOGLE_* port, URL and sign-in client; generic PORT / PUBLIC_BASE_URL are ignored", () => {
  assert.equal(DEFAULT_HTTP_PORT, 47887);
  const generic = { PORT: "8787", PUBLIC_BASE_URL: "https://elsewhere.example", MULTI_GOOGLE_SIGNIN_CLIENT_ID: SIGNIN };
  assert.throws(() => resolveHttpSettings(generic), /MULTI_GOOGLE_PUBLIC_BASE_URL is not set/);
  assert.deepEqual(resolveHttpSettings({ ...generic, MULTI_GOOGLE_PUBLIC_BASE_URL: "https://h.ts.net" }), { port: 47887, publicBaseUrl: "https://h.ts.net", signInClientId: SIGNIN });
  assert.equal(resolveHttpSettings({ MULTI_GOOGLE_PUBLIC_BASE_URL: "https://h", MULTI_GOOGLE_PORT: "50001", MULTI_GOOGLE_SIGNIN_CLIENT_ID: SIGNIN }).port, 50001);
  for (const bad of ["0", "70000", "abc", "1.5"]) {
    assert.throws(() => resolveHttpSettings({ MULTI_GOOGLE_PUBLIC_BASE_URL: "https://h", MULTI_GOOGLE_PORT: bad, MULTI_GOOGLE_SIGNIN_CLIENT_ID: SIGNIN }), /MULTI_GOOGLE_PORT/);
  }
});

test("HTTP mode refuses to start without MULTI_GOOGLE_SIGNIN_CLIENT_ID, before opening the store", async () => {
  assert.throws(() => resolveHttpSettings({ MULTI_GOOGLE_PUBLIC_BASE_URL: "https://h" }), /MULTI_GOOGLE_SIGNIN_CLIENT_ID is not set/);
  assert.throws(() => resolveHttpSettings({ MULTI_GOOGLE_PUBLIC_BASE_URL: "https://h", MULTI_GOOGLE_SIGNIN_CLIENT_ID: "  " }), /MULTI_GOOGLE_SIGNIN_CLIENT_ID is not set/);
  // No store file or key is needed to reach the refusal: it is raised first.
  await assert.rejects(startHttp({ MULTI_GOOGLE_PUBLIC_BASE_URL: "https://h" }), /MULTI_GOOGLE_SIGNIN_CLIENT_ID is not set/);
});
