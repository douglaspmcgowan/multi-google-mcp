import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { getConfigPath } from "./config.js";
import { EncryptedStore, DEFAULT_STORE_FILE, STORE_KEY_ENV } from "./http/store.js";

/**
 * npm run store:keygen  -- new key into the Windows User environment (never printed).
 * npm run store:migrate -- copy the Google client and tokens from config.json into the encrypted store.
 * Neither command prints a key, a token or a secret.
 */

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
  console.log("Usage: store-cli keygen [--force] | migrate");
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
