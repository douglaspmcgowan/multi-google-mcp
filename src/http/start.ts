import path from "node:path";
import { getConfigPath } from "../config.js";
import { EncryptedStore, DEFAULT_STORE_FILE } from "./store.js";
import { createConnectorApp, fileAuditor } from "./app.js";
import { parseAllowedEmails } from "./provider.js";

/** Default listen port: deliberately uncommon so no dev server lands on the Funnel target by default. */
export const DEFAULT_HTTP_PORT = 47887;

/**
 * Port and public URL from MULTI_GOOGLE_PORT / MULTI_GOOGLE_PUBLIC_BASE_URL only. Generic PORT and
 * PUBLIC_BASE_URL are ignored: other tools read them, and a stray value must never move the connector
 * or put another server behind the Funnel. Pure.
 */
export function resolveHttpSettings(env: Record<string, string | undefined>): { port: number; publicBaseUrl: string } {
  const publicBaseUrl = (env.MULTI_GOOGLE_PUBLIC_BASE_URL ?? "").trim();
  if (!publicBaseUrl) throw new Error("MULTI_GOOGLE_PUBLIC_BASE_URL is not set (the https Funnel URL, e.g. https://host.tailnet.ts.net)");
  const raw = (env.MULTI_GOOGLE_PORT ?? "").trim();
  const port = raw ? Number(raw) : DEFAULT_HTTP_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MULTI_GOOGLE_PORT must be an integer 1-65535");
  return { port, publicBaseUrl };
}

/** Starts the remote connector on 127.0.0.1:MULTI_GOOGLE_PORT. Refuses without MULTI_GOOGLE_STORE_KEY or MULTI_GOOGLE_PUBLIC_BASE_URL. */
export async function startHttp(env: Record<string, string | undefined> = process.env): Promise<void> {
  const { port, publicBaseUrl } = resolveHttpSettings(env);
  const store = EncryptedStore.open(env.MULTI_GOOGLE_STORE || DEFAULT_STORE_FILE, env);
  if (!store.data.google.clientId || !store.data.google.clientSecret) {
    throw new Error("The encrypted store has no Google OAuth client. Run: npm run store:migrate");
  }
  const allowedEmails = parseAllowedEmails(env.ALLOWED_EMAILS);
  const auditFile = env.MULTI_GOOGLE_AUDIT_LOG || path.join(path.dirname(getConfigPath()), "audit.log");
  const { app, resourceUrl } = createConnectorApp({ store, publicBaseUrl, allowedEmails, audit: fileAuditor(auditFile) });
  await new Promise<void>((resolve, reject) => {
    const srv = app.listen(port, "127.0.0.1", () => resolve());
    srv.on("error", reject);
  });
  console.error(`multi-google connector listening on 127.0.0.1:${port}; endpoint ${resourceUrl.href}; allowed accounts: ${allowedEmails.size}`);
  if (allowedEmails.size === 0) console.error("ALLOWED_EMAILS is empty: every sign-in will be refused.");
}
