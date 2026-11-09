import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { EncryptedStore, LOCK_STALE_MS, parseStoreKey } from "../src/http/store.js";
import { clientsCommand, migrateConfig } from "../src/store-cli.js";

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

test("a CLI write while the server runs survives the server's next write (two store instances)", () => {
  const dir = tmp();
  const file = path.join(dir, "store.enc");
  const env = { MULTI_GOOGLE_STORE_KEY: key() };
  const server = EncryptedStore.open(file, env);
  server.update((s) => void (s.clients.c1 = { client_id: "c1", client_id_issued_at: 1, redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }));
  // The server has the store loaded; a CLI process opens its own instance and approves.
  const cli = EncryptedStore.open(file, env);
  assert.equal(clientsCommand(cli, "approve", "c1", 5000).startsWith("Approved c1"), true);
  // The server's read sees the approval without a restart...
  assert.ok(server.data.clients.c1.approved_at);
  // ...and the server's next write (from its own possibly older view) keeps it.
  server.update((s) => void (s.codes.h = { clientId: "c1", redirectUri: "x", codeChallenge: "y", email: "e", scopes: [], expiresAt: 9e15 }));
  const fresh = EncryptedStore.open(file, env);
  assert.ok(fresh.data.clients.c1.approved_at, "CLI approval survived");
  assert.ok(fresh.data.codes.h, "server write survived");
});

test("concurrent writers in separate processes lose nothing (file lock + re-read)", async () => {
  const dir = tmp();
  const file = path.join(dir, "store.enc");
  const k = key();
  EncryptedStore.open(file, { MULTI_GOOGLE_STORE_KEY: k }).save();
  const storeModule = pathToFileURL(path.resolve("src/http/store.ts")).href;
  const script =
    `import { EncryptedStore } from ${JSON.stringify(storeModule)};` +
    `const s = EncryptedStore.open(process.argv[1], { MULTI_GOOGLE_STORE_KEY: process.env.K });` +
    `for (let i = 0; i < 25; i++) s.update((st) => { st.clients[process.argv[2] + "-" + i] = { client_id: "x", redirect_uris: [] }; });`;
  const run = (tag: string) =>
    new Promise<number>((resolve) => {
      const p = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, file, tag], { env: { ...process.env, K: k }, stdio: "inherit" });
      p.on("exit", (code) => resolve(code ?? 1));
    });
  const codes = await Promise.all(["a", "b", "c"].map(run));
  assert.deepEqual(codes, [0, 0, 0]);
  const ids = Object.keys(EncryptedStore.open(file, { MULTI_GOOGLE_STORE_KEY: k }).data.clients);
  assert.equal(ids.length, 75);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test("a stale lock left by a crashed process is broken", () => {
  const dir = tmp();
  const file = path.join(dir, "store.enc");
  const s = EncryptedStore.open(file, { MULTI_GOOGLE_STORE_KEY: key() });
  fs.writeFileSync(`${file}.lock`, "99999");
  const old = (Date.now() - LOCK_STALE_MS - 1000) / 1000;
  fs.utimesSync(`${file}.lock`, old, old);
  s.update((st) => void (st.google.clientId = "after-stale-lock"));
  assert.equal(s.data.google.clientId, "after-stale-lock");
});

test("clients CLI: list, approve, revoke (revoke kills its codes and tokens)", () => {
  const file = path.join(tmp(), "store.enc");
  const store = EncryptedStore.open(file, { MULTI_GOOGLE_STORE_KEY: key() });
  const now = 1_700_000_000_000;
  const t = (clientId: string) => ({ clientId, email: "e", scopes: [], expiresAt: now + 1e6, family: "f-" + clientId });
  store.update((s) => {
    s.clients.keep = { client_id: "keep", client_id_issued_at: now / 1000 - 10, redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude", client_secret: "fixture-client-secret" };
    s.clients.gone = { client_id: "gone", client_id_issued_at: now / 1000 - 5, redirect_uris: ["http://localhost:1/cb"] };
    s.accessTokens.a1 = t("gone");
    s.refreshTokens.r1 = t("gone");
    s.accessTokens.a2 = t("keep");
    s.codes.c1 = { clientId: "gone", redirectUri: "x", codeChallenge: "y", email: "e", scopes: [], expiresAt: now + 1e6 };
  });
  const listed = clientsCommand(store, "list", undefined, now);
  assert.match(listed, /keep {2}PENDING .*"Claude" {2}-> claude\.ai {2}\[live tokens\]/);
  assert.match(listed, /gone {2}PENDING/);
  assert.ok(!listed.includes("fixture-client-secret"));
  clientsCommand(store, "approve", "keep", now);
  assert.match(clientsCommand(store, "list", undefined, now), /keep {2}approved /);
  assert.throws(() => clientsCommand(store, "approve", "nope", now), /No client nope/);
  assert.throws(() => clientsCommand(store, "approve", undefined, now), /Usage/);
  clientsCommand(store, "revoke", "gone", now);
  const s = store.data;
  assert.equal(s.clients.gone, undefined);
  assert.deepEqual([s.accessTokens.a1, s.refreshTokens.r1, s.codes.c1], [undefined, undefined, undefined]);
  assert.ok(s.accessTokens.a2 && s.clients.keep.approved_at);
});

test("clients list expires pending clients older than 24 h, never approved ones", () => {
  const store = EncryptedStore.open(path.join(tmp(), "store.enc"), { MULTI_GOOGLE_STORE_KEY: key() });
  const now = 1_700_000_000_000;
  const old = now / 1000 - 25 * 3600;
  store.update((s) => {
    s.clients.stale = { client_id: "stale", client_id_issued_at: old, redirect_uris: [] };
    s.clients.mine = { client_id: "mine", client_id_issued_at: old, approved_at: old, redirect_uris: [] };
  });
  clientsCommand(store, "list", undefined, now);
  assert.deepEqual(Object.keys(store.data.clients), ["mine"]);
});
