import { OAuth2Client } from "google-auth-library";
import http from "http";
import { URL } from "url";
import open from "open";
import {
  loadConfig,
  saveConfig,
  SCOPES,
  REDIRECT_URI,
  shortScopeName,
  type AccountTokens,
} from "./config.js";

export const AUTH_PORT = 3847;
export const START_URL = `http://localhost:${AUTH_PORT}/start`;

export interface OAuthFlowOptions {
  /** Scopes to request; default is the full write list. */
  scopes?: string[];
  /** Never open a browser and never print the authorization URL; serve GET /start instead. */
  noOpen?: boolean;
  loginHint?: string;
  /** Give up after this many seconds (default 300). */
  timeoutSeconds?: number;
}

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
 * The Google authorization URL. Offline access with a forced consent screen so
 * a refresh token comes back; include_granted_scopes is deliberately absent, so
 * a read-only grant never inherits scopes an earlier consent gave. Pure.
 */
export function buildAuthUrl(
  client: Pick<OAuth2Client, "generateAuthUrl">,
  opts: { scopes: string[]; loginHint?: string }
): string {
  return client.generateAuthUrl({
    access_type: "offline",
    scope: opts.scopes,
    prompt: "consent", // force consent to always get refresh_token
    ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
  });
}

export interface AuthRoute {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Routes the pre-callback requests. With noOpen, GET /start redirects to the
 * authorization URL, so an agent-driven browser can be pointed at a fixed
 * localhost address and the URL itself never reaches the terminal. Pure.
 * Returns undefined for /callback, which the flow handles itself.
 */
export function routeAuthRequest(pathname: string, authUrl: string, noOpen: boolean): AuthRoute | undefined {
  if (pathname === "/callback") return undefined;
  if (noOpen && pathname === "/start") return { status: 302, headers: { Location: authUrl } };
  return { status: 404, body: "Not found" };
}

/** What the CLI says when the callback server is listening. With noOpen it never contains the URL. */
export function announceFlowStart(opts: {
  authUrl: string;
  noOpen: boolean;
  log: (line: string) => void;
  opener: (url: string) => unknown;
}): void {
  if (opts.noOpen) {
    opts.log(`\n  Visit ${START_URL}\n`);
    return;
  }
  opts.log(`\n  Opening browser for Google sign-in...\n`);
  opts.log(`  If the browser doesn't open, visit this URL:\n`);
  opts.log(`  ${opts.authUrl}\n`);
  opts.opener(opts.authUrl);
}

/** Short names of the scopes Google reports a token as granted. */
export function grantedShortNames(scope: string | undefined | null): string[] {
  return (scope ?? "").trim().split(/\s+/).filter(Boolean).map(shortScopeName);
}

/**
 * Runs the OAuth flow: opens browser (or serves /start), catches the callback,
 * stores tokens. Resolves with the short names of the scopes actually granted.
 */
export async function runOAuthFlow(accountLabel: string, options: OAuthFlowOptions = {}): Promise<string[]> {
  const config = loadConfig();
  const client = createOAuth2Client(config.clientId, config.clientSecret);
  const noOpen = options.noOpen === true;
  const timeoutSeconds = options.timeoutSeconds ?? 300;

  const authUrl = buildAuthUrl(client, { scopes: options.scopes ?? SCOPES, loginHint: options.loginHint });

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url!, `http://localhost:${AUTH_PORT}`);
        const route = routeAuthRequest(url.pathname, authUrl, noOpen);
        if (route) {
          res.writeHead(route.status, route.headers);
          res.end(route.body);
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
        resolve(grantedShortNames((tokens as AccountTokens).scope));
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
            `Port ${AUTH_PORT} is already in use. Close whatever is using it and try again.\n` +
            `  To find it: lsof -i :${AUTH_PORT}`
          )
        );
      } else {
        reject(err);
      }
    });

    server.listen(AUTH_PORT, () => {
      announceFlowStart({ authUrl, noOpen, log: (l) => console.log(l), opener: open });
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`OAuth flow timed out after ${timeoutSeconds} seconds`));
    }, timeoutSeconds * 1000);
    server.on("close", () => clearTimeout(timer));
  });
}
