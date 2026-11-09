import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EncryptedStore, parseStoreKey } from "../src/http/store.js";
import { migrateConfig } from "../src/store-cli.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mgm-store-"));
const key = () => crypto.randomBytes(32).toString("base64");

test("store round-trips encrypted and the file holds no plaintext", () => {
  const dir = tmp();
  const file = path.join(dir, "store.enc");
  const env = { MULTI_GOOGLE_STORE_KEY: key() };
  const s = EncryptedStore.open(file, env);
  s.update((st) => {
    st.google = { clientId: "fixture-client-id", clientSecret: "fixture-secret-XYZ", accounts: { work: { access_token: "ya29.fixture-access", refresh_token: "1//fixture-refresh", token_type: "Bearer", expiry_date: 1, scope: "x" } } };
  });
  const raw = fs.readFileSync(file, "utf8");
  for (const needle of ["fixture-secret-XYZ", "ya29.fixture-access", "1//fixture-refresh", "fixture-client-id", "work"]) {
    assert.ok(!raw.includes(needle), `plaintext leaked: ${needle.length} chars`);
  }
  const again = EncryptedStore.open(file, env);
  assert.equal(again.data.google.accounts.work.refresh_token, "1//fixture-refresh");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("a wrong key cannot open the store", () => {
  const file = path.join(tmp(), "store.enc");
  EncryptedStore.open(file, { MULTI_GOOGLE_STORE_KEY: key() }).save();
  assert.throws(() => EncryptedStore.open(file, { MULTI_GOOGLE_STORE_KEY: key() }), /decryption failed/);
});

test("missing or short key is refused without echoing it", () => {
  assert.throws(() => parseStoreKey(undefined), /not set/);
  const short = Buffer.from("short").toString("base64");
  assert.throws(() => parseStoreKey(short), (e: Error) => /32 bytes/.test(e.message) && !e.message.includes(short));
});

test("store:migrate copies client and tokens from config.json", () => {
  const dir = tmp();
  const cfg = path.join(dir, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ clientId: "cid", clientSecret: "csec", accounts: { a: { refresh_token: "r1" }, b: { refresh_token: "r2" } } }));
  const store = EncryptedStore.open(path.join(dir, "store.enc"), { MULTI_GOOGLE_STORE_KEY: key() });
  assert.deepEqual(migrateConfig(cfg, store), ["a", "b"]);
  assert.equal(store.data.google.clientSecret, "csec");
  assert.equal((store.data.google.accounts.b as any).refresh_token, "r2");
});
