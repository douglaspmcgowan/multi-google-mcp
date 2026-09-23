import readline from "readline";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { loadConfig, saveConfig, CONFIG_DIR_PATH } from "./config.js";
import { runOAuthFlow } from "./auth.js";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> =>
  new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const PROJECT_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/\/src$/, ""));

function printBanner() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║         Multi-Google MCP Server — Setup                  ║
╚══════════════════════════════════════════════════════════╝
`);
}

function printOAuthInstructions() {
  console.log(`
┌─────────────────────────────────────────────────────────┐
│  STEP 1: Create Google OAuth Credentials                │
│                                                         │
│  You only need to do this ONCE. It takes ~3 minutes.    │
└─────────────────────────────────────────────────────────┘

  1. Go to: https://console.cloud.google.com/

  2. Create a new project (or select an existing one)
     - Click the project dropdown at the top → "New Project"
     - Name it anything (e.g. "Claude MCP")
     - Click "Create"

  3. Enable the APIs:
     - Go to: APIs & Services → Library
     - Search "Gmail API" → click it → click "Enable"
     - Search "Google Calendar API" → click it → click "Enable"

  4. Set up the OAuth consent screen:
     - Go to: APIs & Services → OAuth consent screen
     - Choose "External" → click "Create"
     - Fill in App name (anything, e.g. "Claude MCP")
     - Fill in your email for support email and developer contact
     - Click "Save and Continue" through the remaining steps
     - On the "Test users" page, add every Google email you
       want to connect (this is required while the app is in
       "Testing" mode)
     - Click "Save and Continue"

  5. Create credentials:
     - Go to: APIs & Services → Credentials
     - Click "Create Credentials" → "OAuth client ID"
     - Application type: "Desktop app"
     - Name: anything (e.g. "Claude MCP Desktop")
     - Click "Create"
     - Copy the Client ID and Client Secret

  NOTE: When you sign in, Google will show a warning that says
  "This app isn't verified." This is normal for personal-use
  apps. Click "Advanced" → "Go to <app name> (unsafe)" to
  continue. It's your own app — this is safe.

`);
}

async function setupCredentials(): Promise<void> {
  const config = loadConfig();

  if (config.clientId && config.clientSecret) {
    const reuse = await ask(
      `  Found existing OAuth credentials. Use them? (Y/n): `
    );
    if (reuse.toLowerCase() !== "n") {
      console.log("  Using existing credentials.\n");
      return;
    }
  }

  printOAuthInstructions();

  const clientId = await ask("  Paste your Client ID: ");
  const clientSecret = await ask("  Paste your Client Secret: ");

  if (!clientId || !clientSecret) {
    console.error("\n  Error: Both Client ID and Client Secret are required.");
    process.exit(1);
  }

  config.clientId = clientId;
  config.clientSecret = clientSecret;
  saveConfig(config);
  console.log(`\n  Credentials saved to ${CONFIG_DIR_PATH}/config.json\n`);
}

/**
 * The account label given on the command line, for a non-interactive re-auth:
 * `--account <label>`, `--account=<label>`, or a bare positional label (which
 * survives PowerShell and npm eating a `--` separator).
 */
export function accountFromArgs(argv: string[]): string | undefined {
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--account") return args[i + 1];
    if (arg.startsWith("--account=")) return arg.slice("--account=".length);
  }
  return args.find((arg) => !arg.startsWith("-"));
}

async function addAccount(): Promise<void> {
  const config = loadConfig();
  const existing = Object.keys(config.accounts);

  if (existing.length > 0) {
    console.log(`  Currently connected accounts: ${existing.join(", ")}\n`);
  }

  const label = await ask(
    '  Enter a label for this account (e.g. "personal", "work"): '
  );

  if (!label) {
    console.error("  Error: Account label is required.");
    process.exit(1);
  }

  if (config.accounts[label]) {
    const overwrite = await ask(
      `  Account "${label}" already exists. Overwrite? (y/N): `
    );
    if (overwrite.toLowerCase() !== "y") {
      console.log("  Skipped.\n");
      return;
    }
  }

  console.log(`\n  Connecting account "${label}"...`);
  await runOAuthFlow(label);
  console.log(`\n  Account "${label}" connected successfully!\n`);
}

function registerWithClaudeCode(): void {
  console.log("  Registering MCP server with Claude Code...\n");

  // Resolve the actual project directory from package.json location
  const projectDir = projectRoot();
  const distIndex = path.join(projectDir, "dist", "index.js");

  let settings: any = {};
  if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, "utf-8"));
  }

  if (!settings.mcpServers) {
    settings.mcpServers = {};
  }

  settings.mcpServers["multi-google"] = {
    command: "node",
    args: [distIndex],
  };

  // Ensure the .claude directory exists
  const claudeDir = path.dirname(CLAUDE_SETTINGS_PATH);
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2));
  console.log(`  Registered "multi-google" in ${CLAUDE_SETTINGS_PATH}\n`);
}

function projectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

async function reauthAccount(label: string): Promise<void> {
  const config = loadConfig();
  if (!config.clientId || !config.clientSecret) {
    console.error("  No OAuth credentials found. Run `npm run setup` first.");
    process.exit(1);
  }
  const verb = config.accounts[label] ? "Re-authorizing" : "Connecting";
  console.log(`\n  ${verb} account "${label}" with the current scope list...`);
  if (process.argv.includes("--dry-run")) {
    console.log("  --dry-run: stopping before the browser sign-in.\n");
    return;
  }
  await runOAuthFlow(label);
  console.log(`\n  Account "${label}" authorized. Restart the MCP server (restart Claude Code) to use it.\n`);
}

async function main() {
  const isAddOnly = process.argv.includes("--add-account");
  const label = isAddOnly ? accountFromArgs(process.argv) : undefined;
  if (label) {
    await reauthAccount(label);
    rl.close();
    return;
  }

  if (!isAddOnly) {
    printBanner();
  }

  // Step 1: OAuth credentials
  if (!isAddOnly) {
    await setupCredentials();
  } else {
    const config = loadConfig();
    if (!config.clientId || !config.clientSecret) {
      console.error("  No OAuth credentials found. Run `npm run setup` first.");
      process.exit(1);
    }
  }

  // Step 2: Add account(s)
  let addMore = true;
  while (addMore) {
    await addAccount();
    const another = await ask("  Add another account? (y/N): ");
    addMore = another.toLowerCase() === "y";
  }

  if (!isAddOnly) {
    // Step 3: Build TypeScript
    console.log("  Building TypeScript...\n");
    const { execSync } = await import("child_process");
    const projectDir = projectRoot();
    execSync("npm run build", { cwd: projectDir, stdio: "inherit" });
    console.log("");

    // Step 4: Register with Claude Code
    registerWithClaudeCode();

    console.log(`
╔══════════════════════════════════════════════════════════╗
║  Setup complete!                                         ║
║                                                          ║
║  Restart Claude Code to load the new MCP server.         ║
║                                                          ║
║  To add more accounts later:                             ║
║    cd ~/multi-google-mcp && npm run add-account          ║
╚══════════════════════════════════════════════════════════╝
`);
  } else {
    // Rebuild so tool descriptions update with new account names
    const { execSync } = await import("child_process");
    const projectDir = projectRoot();
    execSync("npm run build", { cwd: projectDir, stdio: "inherit" });
    console.log("\n  Done! Restart Claude Code to pick up the new account.\n");
  }

  rl.close();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
