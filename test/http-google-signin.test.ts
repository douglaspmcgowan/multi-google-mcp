import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { googleSignIn } from "../src/http/app.js";

// A locally generated RSA key stands in for Google's signing key; the client's cert fetch is stubbed, so
// google-auth-library's real verifyIdToken checks run offline. The sign-in client has no secret.
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid";
const AUD = "fixture-signin-client.apps.googleusercontent.com";

function jwt(claims: Record<string, unknown>, signer = privateKey): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "RS256", typ: "JWT", kid: KID });
  const body = b64(claims);
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), signer).toString("base64url");
  return `${head}.${body}.${sig}`;
}

const now = () => Math.floor(Date.now() / 1000);
const good = () => ({ iss: "https://accounts.google.com", aud: AUD, sub: "1", email: "allowed@example.com", email_verified: true, nonce: "n-1", iat: now() - 10, exp: now() + 600 });

function signIn() {
  return googleSignIn(AUD, (id) => {
    const c = new OAuth2Client(id);
    (c as any).getFederatedSignonCertsAsync = async () => ({ certs: { [KID]: publicKey.export({ type: "spki", format: "pem" }).toString() } });
    return c;
  });
}

const verify = (idToken: string) => signIn().verify({ idToken });

test("a valid Google ID token yields the verified email and its nonce", async () => {
  assert.deepEqual(await verify(jwt(good())), { email: "allowed@example.com", emailVerified: true, nonce: "n-1" });
  // Google also issues the bare-host issuer.
  assert.equal((await verify(jwt({ ...good(), iss: "accounts.google.com" }))).emailVerified, true);
});

test("email_verified=false is reported unverified (the callback then refuses it)", async () => {
  assert.equal((await verify(jwt({ ...good(), email_verified: false }))).emailVerified, false);
  assert.equal((await verify(jwt({ ...good(), email_verified: "true" }))).emailVerified, false);
});

test("wrong audience, wrong issuer, expired, or wrong signature is rejected", async () => {
  await assert.rejects(verify(jwt({ ...good(), aud: "someone-else.apps.googleusercontent.com" })), /audience/i);
  await assert.rejects(verify(jwt({ ...good(), iss: "https://evil.example" })), /issuer/i);
  await assert.rejects(verify(jwt({ ...good(), iat: now() - 7200, exp: now() - 3600 })), /late|expired/i);
  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  await assert.rejects(verify(jwt(good(), other)), /signature/i);
});

test("the auth URL is an OpenID Connect implicit ID-token request with form_post, nonce and state, and no secret or PKCE", () => {
  const url = new URL(signIn().authUrl({ state: "s-1", nonce: "n-1", redirectUri: "https://h/oauth/google/callback" }));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  const q = url.searchParams;
  assert.equal(q.get("client_id"), AUD);
  assert.equal(q.get("response_type"), "id_token");
  assert.equal(q.get("response_mode"), "form_post");
  assert.equal(q.get("scope"), "openid email");
  assert.equal(q.get("redirect_uri"), "https://h/oauth/google/callback");
  assert.equal(q.get("state"), "s-1");
  assert.equal(q.get("nonce"), "n-1");
  assert.equal(q.has("client_secret"), false);
  assert.equal(q.has("code_challenge"), false);
});

test("a sign-in without its client id is refused", () => {
  assert.throws(() => googleSignIn(""), /MULTI_GOOGLE_SIGNIN_CLIENT_ID/);
});
