import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveConfigPath,
  resolveSetupConfigPath,
  prepareReadOnlyConfig,
  describeAccountScopes,
  isReadOnlyMode,
  shortScopeName,
  SCOPES,
  READ_ONLY_SCOPES,
} from "../src/config.js";
import { parseSetupArgs, accountFromArgs, scopesForRun } from "../src/setup.js";

const NORMAL = path.join(os.tmpdir(), "mg-test", "config.json");
const RO = path.join(os.tmpdir(), "mg-test", "config.readonly.json");

test("MULTI_GOOGLE_CONFIG overrides the config path; default otherwise", () => {
  assert.equal(resolveConfigPath({}, NORMAL), NORMAL);
  assert.equal(resolveConfigPath({ MULTI_GOOGLE_CONFIG: "  " }, NORMAL), NORMAL);
  assert.equal(resolveConfigPath({ MULTI_GOOGLE_CONFIG: RO }, NORMAL), path.resolve(RO));
});

test("a read-only run defaults to config.readonly.json and refuses config.json", () => {
  assert.equal(
    resolveSetupConfigPath({ readOnly: true, env: {}, defaultPath: NORMAL, readOnlyPath: RO }),
    RO
  );
  assert.equal(
    resolveSetupConfigPath({ readOnly: false, env: {}, defaultPath: NORMAL, readOnlyPath: RO }),
    NORMAL
  );
  assert.throws(
    () => resolveSetupConfigPath({ readOnly: true, configArg: NORMAL, env: {}, defaultPath: NORMAL, readOnlyPath: RO }),
    /Refusing/
  );
  assert.throws(
    () =>
      resolveSetupConfigPath({
        readOnly: true,
        env: { MULTI_GOOGLE_CONFIG: NORMAL },
        defaultPath: NORMAL,
        readOnlyPath: RO,
      }),
    /Refusing/
  );
  const other = path.join(os.tmpdir(), "mg-test", "other.json");
  assert.equal(
    resolveSetupConfigPath({ readOnly: true, configArg: other, env: {}, defaultPath: NORMAL, readOnlyPath: RO }),
    path.resolve(other)
  );
});

test("prepareReadOnlyConfig copies client credentials, sets readOnly, and keeps accounts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mg-cfg-"));
  try {
    const src = path.join(dir, "config.json");
    const target = path.join(dir, "config.readonly.json");
    fs.writeFileSync(src, JSON.stringify({ clientId: "ID-X", clientSecret: "SECRET-X", accounts: { a: { scope: "s" } } }));
    prepareReadOnlyConfig(target, src);
    const made = JSON.parse(fs.readFileSync(target, "utf-8"));
    assert.equal(made.readOnly, true);
    assert.equal(made.clientId, "ID-X");
    assert.equal(made.clientSecret, "SECRET-X");
    assert.deepEqual(made.accounts, {}); // tokens are never copied across configs
    // A second run keeps existing accounts.
    made.accounts.keep = { scope: "gmail.readonly" };
    fs.writeFileSync(target, JSON.stringify(made));
    prepareReadOnlyConfig(target, src);
    assert.ok(JSON.parse(fs.readFileSync(target, "utf-8")).accounts.keep);
    // The normal config is untouched.
    assert.equal(JSON.parse(fs.readFileSync(src, "utf-8")).readOnly, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("read-only mode: env 1/true or config readOnly true", () => {
  assert.equal(isReadOnlyMode({}, { readOnly: true }), true);
  assert.equal(isReadOnlyMode({}, { readOnly: false }), false);
  assert.equal(isReadOnlyMode({}, {}), false);
  assert.equal(isReadOnlyMode({ MULTI_GOOGLE_READ_ONLY: "1" }, { readOnly: false }), true);
  assert.equal(isReadOnlyMode({ MULTI_GOOGLE_READ_ONLY: "0" }, undefined), false);
});

test("READ_ONLY_SCOPES holds only read scopes; SCOPES carries the forward-looking grants", () => {
  assert.equal(READ_ONLY_SCOPES.length, 10);
  for (const s of READ_ONLY_SCOPES) assert.match(shortScopeName(s), /readonly$/);
  const names = SCOPES.map(shortScopeName);
  for (const n of ["contacts", "gmail.settings.basic", "meetings.space.created"]) assert.ok(names.includes(n), n);
  assert.deepEqual(
    READ_ONLY_SCOPES.map(shortScopeName),
    [
      "gmail.readonly", "calendar.readonly", "drive.readonly", "tasks.readonly",
      "contacts.readonly", "contacts.other.readonly", "forms.body.readonly", "forms.responses.readonly",
      "meetings.space.readonly", "directory.readonly",
    ]
  );
});

test("describeAccountScopes prints names and short scopes, never tokens", () => {
  const lines = describeAccountScopes({
    accounts: {
      a: { access_token: "TOKEN-A", refresh_token: "REFRESH-A", token_type: "Bearer", expiry_date: 1, scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.readonly" },
      b: { access_token: null, refresh_token: null, token_type: null, expiry_date: null, scope: "" },
    },
  });
  assert.deepEqual(lines, ["a: gmail.readonly, drive.readonly", "b: (no scopes recorded)"]);
  assert.ok(!lines.join("\n").includes("TOKEN"));
});

test("CLI parsing: flags, positional label, and value flags not taken as labels", () => {
  const argv = ["node", "setup.ts", "--add-account", "--account", "ro", "--read-only", "--no-open", "--login-hint", "a@b.c", "--timeout-seconds", "60"];
  const p = parseSetupArgs(argv);
  assert.equal(p.account, "ro");
  assert.equal(p.readOnly, true);
  assert.equal(p.noOpen, true);
  assert.equal(p.loginHint, "a@b.c");
  assert.equal(p.timeoutSeconds, 60);
  assert.equal(parseSetupArgs(["node", "s", "--add-account", "x"]).timeoutSeconds, 300);
  assert.equal(accountFromArgs(["node", "s", "--add-account", "--config", "/p/c.json", "lbl"]), "lbl");
  assert.equal(parseSetupArgs(["node", "s", "--list-accounts-scopes"]).listAccountsScopes, true);
  assert.throws(() => parseSetupArgs(["node", "s", "--timeout-seconds", "0"]));
});

test("scopesForRun: read-only flag or read-only config selects the read-only list", () => {
  assert.equal(scopesForRun(true, {}), READ_ONLY_SCOPES);
  assert.equal(scopesForRun(false, { readOnly: true }), READ_ONLY_SCOPES);
  assert.equal(scopesForRun(false, {}), SCOPES);
});
