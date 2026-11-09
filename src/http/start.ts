import path from "node:path";
import { getConfigPath } from "../config.js";
import { EncryptedStore, DEFAULT_STORE_FILE } from "./store.js";
import { createConnectorApp, fileAuditor } from "./app.js";
import { parseAllowedEmails } from "./provider.js";

/** Starts the remote connector on 127.0.0.1:PORT. Refuses without MULTI_GOOGLE_STORE_KEY or PUBLIC_BASE_URL. */
export async function startHttp(env: Record<string, string | undefined> = process.env): Promise<void> {
  const store = EncryptedStore.open(env.MULTI_GOOGLE_STORE || DEFAULT_STORE_FILE, env);
  const publicBaseUrl = (env.PUBLIC_BASE_URL ?? "").trim();
  if (!publicBaseUrl) throw new Error("PUBLIC_BASE_URL is not set (the https Funnel URL, e.g. https://host.tailnet.ts.net)");
  if (!store.data.google.clientId || !store.data.google.clientSecret) {
    throw new Error("The encrypted store has no Google OAuth client. Run: npm run store:migrate");
  }
  const port = Number(env.PORT || 8787);
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
