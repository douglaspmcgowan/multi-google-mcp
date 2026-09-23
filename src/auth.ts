import { OAuth2Client } from "google-auth-library";
import http from "http";
import { URL } from "url";
import open from "open";
import {
  loadConfig,
  saveConfig,
  SCOPES,
  REDIRECT_URI,
  type AccountTokens,
} from "./config.js";

export function createOAuth2Client(clientId: string, clientSecret: string) {
  return new OAuth2Client(clientId, clientSecret, REDIRECT_URI);
}

export function getAuthenticatedClient(accountName: string) {
  const config = loadConfig();
  if (!config.clientId || !config.clientSecret) {
    throw new Error("Google OAuth credentials not configured. Run: npm run setup");
  }
  const tokens = config.accounts[accountName];
  if (!tokens) {
    throw new Error(
      `Account "${accountName}" not found. Available: ${Object.keys(config.accounts).join(", ") || "none"}`
    );
  }
  const client = createOAuth2Client(config.clientId, config.clientSecret);
  client.setCredentials(tokens);

  // Auto-refresh tokens and persist them
  client.on("tokens", (newTokens) => {
    const current = loadConfig();
    if (current.accounts[accountName]) {
      current.accounts[accountName] = {
        ...current.accounts[accountName],
        ...newTokens,
      };
      saveConfig(current);
    }
  });

  return client;
}

/**
 * Runs the OAuth flow: opens browser, catches the callback, stores tokens.
 * Returns the account label.
 */
export async function runOAuthFlow(accountLabel: string): Promise<void> {
  const config = loadConfig();
  const client = createOAuth2Client(config.clientId, config.clientSecret);

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent", // force consent to always get refresh_token
  });

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url!, `http://localhost:3847`);
        if (url.pathname !== "/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400);
          res.end(`Authorization failed: ${error}`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code) {
          res.writeHead(400);
          res.end("No authorization code received");
          server.close();
          reject(new Error("No auth code"));
          return;
        }

        const { tokens } = await client.getToken(code);
        const current = loadConfig();
        current.accounts[accountLabel] = tokens as AccountTokens;
        saveConfig(current);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <html><body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
            <div style="text-align: center;">
              <h1>Account "${accountLabel}" connected</h1>
              <p>You can close this tab and return to your terminal.</p>
            </div>
          </body></html>
        `);

        server.close();
        resolve();
      } catch (err) {
        res.writeHead(500);
        res.end("Internal error");
        server.close();
        reject(err);
      }
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            "Port 3847 is already in use. Close whatever is using it and try again.\n" +
            "  To find it: lsof -i :3847"
          )
        );
      } else {
        reject(err);
      }
    });

    server.listen(3847, () => {
      console.log(`\n  Opening browser for Google sign-in...\n`);
      console.log(`  If the browser doesn't open, visit this URL:\n`);
      console.log(`  ${authUrl}\n`);
      open(authUrl);
    });

    // Timeout after 2 minutes
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("OAuth flow timed out after 2 minutes"));
    }, 120_000);
    server.on("close", () => clearTimeout(timer));
  });
}
