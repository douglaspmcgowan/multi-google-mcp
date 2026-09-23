import { loadConfig } from "./config.js";

const PREFIX = "https://www.googleapis.com/auth/";

/** The command that re-runs consent for one account and overwrites its stored token. */
export function reauthCommand(account: string): string {
  return `cd "$env:USERPROFILE\\multi-google-mcp"; npm run add-account -- --account ${account}`;
}

export class ScopeError extends Error {
  constructor(account: string, needed: string[]) {
    const names = needed.map((s) => s.replace(PREFIX, "")).join(" or ");
    super(
      `Re-auth needed: account "${account}" was authorized before scope ${names} was added. ` +
        `Run in PowerShell: ${reauthCommand(account)}  — then restart the MCP server. ` +
        "The Google Cloud project must also have the matching API enabled."
    );
    this.name = "ScopeError";
  }
}

/** Scopes the stored refresh token was granted, or undefined when the config does not say. */
export function grantedScopes(account: string): string[] | undefined {
  const tokens = loadConfig().accounts[account];
  if (!tokens || typeof tokens.scope !== "string" || tokens.scope.trim() === "") return undefined;
  return tokens.scope.trim().split(/\s+/);
}

export type ScopeLookup = (account: string) => string[] | undefined;

/**
 * Throws ScopeError unless the account's token carries at least one of
 * `anyOf`. A token that records no scopes is let through; Google's own 403
 * is then translated by `translateScopeError`.
 */
export function requireScope(account: string, anyOf: string[], lookup: ScopeLookup = grantedScopes): void {
  const granted = lookup(account);
  if (!granted) return;
  if (anyOf.some((scope) => granted.includes(scope))) return;
  throw new ScopeError(account, anyOf);
}

/** Rewrites Google's "insufficient authentication scopes" 403 into the re-auth message. */
export function translateScopeError(error: unknown, account: string, anyOf: string[]): unknown {
  const message = (error as { message?: string })?.message ?? String(error);
  if (/insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions/i.test(message)) {
    return new ScopeError(account, anyOf);
  }
  return error;
}

export async function withScope<T>(
  account: string,
  anyOf: string[],
  lookup: ScopeLookup,
  run: () => Promise<T>
): Promise<T> {
  requireScope(account, anyOf, lookup);
  try {
    return await run();
  } catch (error) {
    throw translateScopeError(error, account, anyOf);
  }
}

export const SCOPE = {
  drive: `${PREFIX}drive`,
  formsBody: `${PREFIX}forms.body`,
  formsResponses: `${PREFIX}forms.responses.readonly`,
  chatSpaces: `${PREFIX}chat.spaces`,
  chatSpacesReadonly: `${PREFIX}chat.spaces.readonly`,
  chatMessages: `${PREFIX}chat.messages`,
  chatMessagesCreate: `${PREFIX}chat.messages.create`,
  chatMemberships: `${PREFIX}chat.memberships`,
  chatMembershipsReadonly: `${PREFIX}chat.memberships.readonly`,
} as const;
