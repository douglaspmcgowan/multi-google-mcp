import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OAuth2Client } from "google-auth-library";
import { EncryptedStore } from "../src/http/store.js";
import { googleSignIn } from "../src/http/app.js";

// A locally generated RSA key stands in for Google's signing key; the client's cert fetch and token
// endpoint are stubbed, so google-auth-library's real verifyIdToken checks run offline.
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid";
const AUD = "fixture-client.apps.googleusercontent.com";

function jwt(claims: Record<string, unknown>, signer = privateKey): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "RS256", typ: "JWT", kid: KID });
  const body = b64(claims);
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), signer).toString("base64url");
  return `${head}.${body}.${sig}`;
}

const now = () => Math.floor(Date.now() / 1000);
const good = () => ({ iss: "https://accounts.google.com", aud: AUD, sub: "1", email: "allowed@example.com", email_verified: true, iat: now() - 10, exp: now() + 600 });

function signInWith(idToken: string) {
  const store = EncryptedStore.open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mgm-gsi-")), "store.enc"), { MULTI_GOOGLE_STORE_KEY: crypto.randomBytes(32).toString("base64") });
  store.update((s) => void (s.google = { clientId: AUD, clientSecret: "fixture-secret", accounts: {} }));
  return googleSignIn(store, (id, secret, uri) => {
    const c = new OAuth2Client(id, secret, uri);
    (c as any).getToken = async () => ({ tokens: { id_token: idToken } });
    (c as any).getFederatedSignonCertsAsync = async () => ({ certs: { [KID]: publicKey.export({ type: "spki", format: "pem" }).toString() } });
    return c;
  });
}

const exchange = (idToken: string) => signInWith(idToken).exchange({ code: "c", codeVerifier: "v", redirectUri: "https://h/oauth/google/callback" });

test("a valid Google ID token yields the verified email", async () => {
  assert.deepEqual(await exchange(jwt(good())), { email: "allowed@example.com", emailVerified: true });
  // Google also issues the bare-host issuer.
  assert.equal((await exchange(jwt({ ...good(), iss: "accounts.google.com" }))).emailVerified, true);
});

test("email_verified=false is reported unverified (the callback then refuses it)", async () => {
  assert.equal((await exchange(jwt({ ...good(), email_verified: false }))).emailVerified, false);
  assert.equal((await exchange(jwt({ ...good(), email_verified: "true" }))).emailVerified, false);
});

test("wrong audience, wrong issuer, expired, or wrong signature is rejected", async () => {
  await assert.rejects(exchange(jwt({ ...good(), aud: "someone-else.apps.googleusercontent.com" })), /audience/i);
  await assert.rejects(exchange(jwt({ ...good(), iss: "https://evil.example" })), /issuer/i);
  await assert.rejects(exchange(jwt({ ...good(), iat: now() - 7200, exp: now() - 3600 })), /late|expired/i);
  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  await assert.rejects(exchange(jwt(good(), other)), /signature/i);
});

test("no ID token from Google is rejected", async () => {
  const store = EncryptedStore.open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mgm-gsi-")), "store.enc"), { MULTI_GOOGLE_STORE_KEY: crypto.randomBytes(32).toString("base64") });
  store.update((s) => void (s.google = { clientId: AUD, clientSecret: "x", accounts: {} }));
  const g = googleSignIn(store, (id, secret, uri) => Object.assign(new OAuth2Client(id, secret, uri), { getToken: async () => ({ tokens: {} }) }) as OAuth2Client);
  await assert.rejects(g.exchange({ code: "c", codeVerifier: "v", redirectUri: "https://h/cb" }), /no ID token/);
});
