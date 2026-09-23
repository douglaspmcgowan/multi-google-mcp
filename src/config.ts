import fs from "fs";
import path from "path";
import os from "os";

const CONFIG_DIR = path.join(os.homedir(), ".config", "multi-google-mcp");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

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
  accounts: Record<string, AccountTokens>;
}

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): Config {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    return { clientId: "", clientSecret: "", accounts: {} };
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
}

export function saveConfig(config: Config): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  fs.chmodSync(CONFIG_FILE, 0o600); // restrict permissions — tokens are sensitive
}

export function getAccountNames(): string[] {
  const config = loadConfig();
  return Object.keys(config.accounts);
}

export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive",
];

export const REDIRECT_URI = "http://localhost:3847/callback";
export const CONFIG_DIR_PATH = CONFIG_DIR;
