import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { getConfigPath } from "./config.js";
import { EncryptedStore, DEFAULT_STORE_FILE, STORE_KEY_ENV } from "./http/store.js";
import { approveClient, clientHasLiveTokens, expirePendingClients, revokeClient } from "./http/provider.js";

/**
 * npm run store:keygen  -- new key into the Windows User environment (never printed).
 * npm run store:migrate -- copy the Google client and tokens from config.json into the encrypted store.
 * npm run clients:list | clients:approve -- <client_id> | clients:revoke -- <client_id>
 *   -- manage connector clients (DCR registrations). Safe while the server runs: every write is a locked
 *      read-modify-write of the store.
 * No command prints a key, a token or a secret.
 */

/** One line per registered client: id, status, name, registration time, live-token flag. Never a secret. */
export function listClients(store: EncryptedStore, now: number = Date.now()): string[] {
  return store.update((s) => {
    expirePendingClients(s, now);
    return Object.values(s.clients)
      .sort((a, b) => (a.client_id_issued_at ?? 0) - (b.client_id_issued_at ?? 0))
      .map((c) => {
        const when = (t?: number) => (t ? new Date(t * 1000).toISOString() : "?");
        const status = c.approved_at ? `approved ${when(c.approved_at)}` : "PENDING";
        const name = typeof c.client_name === "string" ? JSON.stringify(c.client_name.slice(0, 60)) : "(no name)";
        const redirect = (c.redirect_uris ?? []).map((u) => { try { return new URL(String(u)).host; } catch { return "?"; } }).join(",");
        return `${c.client_id}  ${status}  registered ${when(c.client_id_issued_at)}  ${name}  -> ${redirect}${clientHasLiveTokens(s, c.client_id, now) ? "  [live tokens]" : ""}`;
      });
  });
}

/** Runs one clients subcommand against the store. Returns the message to print; throws on a bad id. */
export function clientsCommand(store: EncryptedStore, sub: string, id: string | undefined, now: number = Date.now()): string {
  if (sub === "list") {
    const lines = listClients(store, now);
    return lines.length ? lines.join("\n") : "No registered clients.";
  }
  if (!id) throw new Error(`Usage: npm run clients:${sub} -- <client_id>`);
  if (sub === "approve") {
    if (!store.update((s) => approveClient(s, id, now))) throw new Error(`No client ${id}. List them with: npm run clients:list`);
    return `Approved ${id}. Connect again from Claude.`;
  }
  if (sub === "revoke") {
    if (!store.update((s) => revokeClient(s, id))) throw new Error(`No client ${id}.`);
    return `Revoked ${id} and every code and token issued to it.`;
  }
  throw new Error("Usage: store-cli clients list | approve <client_id> | revoke <client_id>");
}

/** Copies client id/secret and accounts from a plaintext config into the store. Returns the account names. */
export function migrateConfig(configFile: string, store: EncryptedStore): string[] {
  if (!fs.existsSync(configFile)) throw new Error(`No config at ${configFile}. Run: npm run setup`);
  const cfg = JSON.parse(fs.readFileSync(configFile, "utf-8"));
  const names = Object.keys(cfg.accounts ?? {});
  store.update((s) => {
    s.google.clientId = cfg.clientId ?? "";
    s.google.clientSecret = cfg.clientSecret ?? "";
    s.google.accounts = { ...s.google.accounts, ...(cfg.accounts ?? {}) };
    if (cfg.readOnly === true) s.google.readOnly = true;
  });
  return names;
}

function keygen(force: boolean): void {
  const key = crypto.randomBytes(32).toString("base64");
  if (process.platform !== "win32") {
    console.log(
      `Linux/macOS: generate a key and keep it in your secret manager or service environment, never in the repo:\n` +
        `  export ${STORE_KEY_ENV}="$(openssl rand -base64 32)"\n` +
        `Losing the key makes the store unreadable; re-run npm run store:migrate with the new key.`
    );
    return;
  }
  // Check presence through the registry value names only; the value is never read.
  const check = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Item 'HKCU:\\Environment').GetValueNames() -contains '${STORE_KEY_ENV}'`], { encoding: "utf8" });
  if (check.status !== 0) throw new Error("pwsh (PowerShell 7) is required for store:keygen on Windows");
  if (check.stdout.trim() === "True" && !force) {
    console.log(`${STORE_KEY_ENV} already exists in the User environment. A new key orphans the current store; pass --force to replace it, then re-run store:migrate.`);
    return;
  }
  // The key goes over stdin, never on a command line.
  const set = spawnSync(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", `$k = [Console]::In.ReadLine(); [Environment]::SetEnvironmentVariable('${STORE_KEY_ENV}', $k, 'User')`],
    { input: key + "\n", encoding: "utf8", stdio: ["pipe", "ignore", "inherit"] }
  );
  if (set.status !== 0) throw new Error("Writing the key to the User environment failed");
  console.log(`${STORE_KEY_ENV} written to the Windows User environment. Open a new terminal, then run: npm run store:migrate`);
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "keygen") return keygen(rest.includes("--force"));
  if (cmd === "migrate") {
    const file = process.env.MULTI_GOOGLE_STORE || DEFAULT_STORE_FILE;
    const names = migrateConfig(getConfigPath(), EncryptedStore.open(file));
    console.log(`Migrated ${names.length} account(s) (${names.join(", ")}) and the OAuth client into ${file}. config.json is unchanged; the stdio server keeps using it.`);
    return;
  }
  if (cmd === "clients") {
    const file = process.env.MULTI_GOOGLE_STORE || DEFAULT_STORE_FILE;
    console.log(clientsCommand(EncryptedStore.open(file), rest[0] ?? "", rest[1]));
    return;
  }
  console.log("Usage: store-cli keygen [--force] | migrate | clients list|approve|revoke [client_id]");
  process.exitCode = 2;
}

if (process.argv[1] && /store-cli\.(ts|js)$/.test(process.argv[1])) {
  try {
    main();
  } catch (e: any) {
    console.error(e?.message ?? String(e));
    process.exit(1);
  }
}
