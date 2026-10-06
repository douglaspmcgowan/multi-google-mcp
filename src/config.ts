import fs from "fs";
import path from "path";
import os from "os";

const CONFIG_DIR = path.join(os.homedir(), ".config", "multi-google-mcp");
/** The normal (write-capable) config. Never the target of a read-only consent. */
export const DEFAULT_CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
/** The read-only config's default location, beside the normal one. */
export const READONLY_CONFIG_FILE = path.join(CONFIG_DIR, "config.readonly.json");

/** The config file path: MULTI_GOOGLE_CONFIG when set, else the default. Pure. */
export function resolveConfigPath(
  env: Record<string, string | undefined> = process.env,
  defaultPath: string = DEFAULT_CONFIG_FILE
): string {
  const v = (env.MULTI_GOOGLE_CONFIG ?? "").trim();
  return v ? path.resolve(v) : defaultPath;
}

let configFile = resolveConfigPath(process.env);

/** Point every later loadConfig/saveConfig at another file (the `--config` flag). */
export function setConfigPath(p: string): void {
  configFile = path.resolve(p);
}

export function getConfigPath(): string {
  return configFile;
}

export interface AccountTokens {
  access_token: string | null;
  refresh_token: string | null;
  token_type: string | null;
  expiry_date: number | null;
  scope: string;
}

export interface Config {
  clientId: string;
  clientSecret: string;
  /** True in a config whose grants are read-only; the server then hides every write tool. */
  readOnly?: boolean;
  accounts: Record<string, AccountTokens>;
}

function ensureConfigDir(): void {
  const dir = path.dirname(configFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadConfig(): Config {
  ensureConfigDir();
  if (!fs.existsSync(configFile)) {
    return { clientId: "", clientSecret: "", accounts: {} };
  }
  return JSON.parse(fs.readFileSync(configFile, "utf-8"));
}

export function saveConfig(config: Config): void {
  ensureConfigDir();
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  fs.chmodSync(configFile, 0o600); // restrict permissions — tokens are sensitive
}

export function getAccountNames(): string[] {
  const config = loadConfig();
  return Object.keys(config.accounts);
}

const A = "https://www.googleapis.com/auth/";

export const SCOPES = [
  `${A}gmail.modify`,
  `${A}gmail.compose`,
  `${A}gmail.labels`,
  `${A}calendar`,
  `${A}calendar.events`,
  `${A}drive`,
  // Google Chat (user auth). Tokens granted before these were added lack them;
  // the Chat tools then refuse with a re-auth command (src/scopes.ts).
  `${A}chat.spaces`,
  `${A}chat.messages`,
  `${A}chat.memberships`,
  // Google Forms. The drive scope already satisfies forms.create and
  // forms.responses.list; these are requested so a re-authorized token names them.
  `${A}forms.body`,
  `${A}forms.responses.readonly`,
  // Google Tasks and contacts lookup. Older tokens lack these; those tools then
  // return the add-account command for the affected account.
  `${A}tasks`,
  `${A}contacts.readonly`,
  `${A}contacts.other.readonly`,
  // Requested ahead of the tools that will use them (contact writes, Gmail
  // settings such as filters and forwarding, Meet spaces) so a later tool does
  // not force another consent pass on every account.
  `${A}contacts`,
  `${A}gmail.settings.basic`,
  `${A}meetings.space.created`,
];

/**
 * The grant a read-only config asks for. Google itself refuses writes on a
 * token carrying only these, whatever tools the server registers.
 */
export const READ_ONLY_SCOPES = [
  `${A}gmail.readonly`,
  `${A}calendar.readonly`,
  `${A}drive.readonly`,
  `${A}tasks.readonly`,
  `${A}contacts.readonly`,
  `${A}contacts.other.readonly`,
  `${A}forms.body.readonly`,
  `${A}forms.responses.readonly`,
];

/** "https://www.googleapis.com/auth/gmail.readonly" -> "gmail.readonly". */
export function shortScopeName(scope: string): string {
  return scope.startsWith(A) ? scope.slice(A.length) : scope;
}

/**
 * True when MULTI_GOOGLE_READ_ONLY is "1" or "true", or the loaded config says
 * `readOnly: true`: the server then lists only read tools. Pure.
 */
export function isReadOnlyMode(
  env: Record<string, string | undefined> = process.env,
  config?: { readOnly?: boolean }
): boolean {
  const v = (env.MULTI_GOOGLE_READ_ONLY ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || config?.readOnly === true;
}

/**
 * Where a consent run writes. `--config` (or MULTI_GOOGLE_CONFIG) wins; a
 * read-only run with neither uses config.readonly.json. A read-only run is
 * refused the normal config.json: it would downgrade that file's server to
 * read-only mode and mix grants. Pure.
 */
export function resolveSetupConfigPath(opts: {
  readOnly: boolean;
  configArg?: string;
  env?: Record<string, string | undefined>;
  defaultPath?: string;
  readOnlyPath?: string;
}): string {
  const defaultPath = opts.defaultPath ?? DEFAULT_CONFIG_FILE;
  const readOnlyPath = opts.readOnlyPath ?? READONLY_CONFIG_FILE;
  const fromArg = (opts.configArg ?? "").trim();
  let target: string;
  if (fromArg) target = path.resolve(fromArg);
  else if ((opts.env?.MULTI_GOOGLE_CONFIG ?? "").trim()) target = resolveConfigPath(opts.env, defaultPath);
  else target = opts.readOnly ? readOnlyPath : defaultPath;
  if (opts.readOnly && path.resolve(target) === path.resolve(defaultPath)) {
    throw new Error(
      "Refusing to write a read-only consent into the normal config.json. " +
        "Omit --config to use config.readonly.json, or name another file."
    );
  }
  return target;
}

/**
 * Makes the read-only config file exist and carry `readOnly: true`. A new file
 * gets the OAuth client id and secret copied in memory from `sourcePath` (the
 * normal config); neither value is printed or returned.
 */
export function prepareReadOnlyConfig(targetPath: string, sourcePath: string = DEFAULT_CONFIG_FILE): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  let cfg: Config;
  if (fs.existsSync(targetPath)) {
    cfg = JSON.parse(fs.readFileSync(targetPath, "utf-8"));
    if (!cfg.accounts) cfg.accounts = {};
  } else {
    cfg = { clientId: "", clientSecret: "", accounts: {} };
    if (fs.existsSync(sourcePath)) {
      const src = JSON.parse(fs.readFileSync(sourcePath, "utf-8")) as Partial<Config>;
      cfg.clientId = src.clientId ?? "";
      cfg.clientSecret = src.clientSecret ?? "";
    }
  }
  cfg.readOnly = true;
  fs.writeFileSync(targetPath, JSON.stringify(cfg, null, 2));
  fs.chmodSync(targetPath, 0o600);
}

/** One line per account: its name and its granted scope short names. Never a token. */
export function describeAccountScopes(config: Pick<Config, "accounts">): string[] {
  return Object.entries(config.accounts).map(([name, t]) => {
    const scopes = typeof t?.scope === "string" ? t.scope.trim().split(/\s+/).filter(Boolean).map(shortScopeName) : [];
    return `${name}: ${scopes.length ? scopes.join(", ") : "(no scopes recorded)"}`;
  });
}

export const REDIRECT_URI = "http://localhost:3847/callback";
export const CONFIG_DIR_PATH = CONFIG_DIR;
