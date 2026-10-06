import type { people_v1 } from "@googleapis/people";
import { getAuthenticatedClient } from "../auth.js";
import { getAccountNames } from "../config.js";
import { grantedScopes, withScope, type ScopeLookup } from "../scopes.js";
import type { ToolDef } from "./types.js";

type PeopleClient = people_v1.People;

export const CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";
export const OTHER_CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts.other.readonly";

const READ_MASK = "names,emailAddresses,phoneNumbers";

async function getPeople(account: string): Promise<PeopleClient> {
  const { people } = await import("@googleapis/people");
  return people({ version: "v1", auth: getAuthenticatedClient(account) as never });
}

function accountDescription(getAccounts: () => string[]): string {
  let names: string[];
  try {
    names = getAccounts();
  } catch {
    return "Account availability could not be determined.";
  }
  if (names.length === 0) return "No accounts configured.";
  return `Available accounts: ${names.join(", ")}`;
}

function toContact(person: people_v1.Schema$Person | undefined, source: "contacts" | "other") {
  return {
    source,
    names: (person?.names || []).map((n) => n.displayName).filter(Boolean),
    emails: (person?.emailAddresses || []).map((e) => e.value).filter(Boolean),
    phones: (person?.phoneNumbers || []).map((p) => p.value).filter(Boolean),
  };
}

export function createContactsTools(
  getClient: (account: string) => PeopleClient | Promise<PeopleClient> = getPeople,
  getAccounts: () => string[] = getAccountNames,
  lookup: ScopeLookup = grantedScopes
): ToolDef[] {
  return [
    {
      name: "contacts_search",
      readOnly: true,
      description:
        "Look up people by name, email or phone in an account's saved contacts and in the 'other contacts' " +
        `(people it has emailed). Returns names, email addresses and phone numbers. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account: { type: "string", description: "Account label" },
          query: { type: "string", description: "Name, email or phone fragment" },
          max_results: { type: "number", description: "Max results per source (default 10)" },
        },
        required: ["account", "query"],
      },
      handler: async (args: { account: string; query: string; max_results?: number }) => {
        const people = await getClient(args.account);
        const pageSize = args.max_results || 10;
        const warnings: string[] = [];
        const contacts: ReturnType<typeof toContact>[] = [];

        // Each source needs its own scope; one missing must not hide the other.
        const sources: Array<[string, "contacts" | "other", () => Promise<people_v1.Schema$Person[]>]> = [
          [
            CONTACTS_SCOPE,
            "contacts",
            async () => {
              const res = await people.people.searchContacts({ query: args.query, readMask: READ_MASK, pageSize });
              return (res.data.results || []).map((r) => r.person!).filter(Boolean);
            },
          ],
          [
            OTHER_CONTACTS_SCOPE,
            "other",
            async () => {
              const res = await people.otherContacts.search({ query: args.query, readMask: READ_MASK, pageSize });
              return (res.data.results || []).map((r) => r.person!).filter(Boolean);
            },
          ],
        ];
        let failures = 0;
        let firstError: unknown;
        for (const [scope, source, fn] of sources) {
          try {
            const persons = await withScope(args.account, [scope], lookup, fn);
            contacts.push(...persons.map((p) => toContact(p, source)));
          } catch (e) {
            failures++;
            firstError ??= e;
            warnings.push(`${source}: ${(e as Error).message}`);
          }
        }
        if (failures === sources.length) throw firstError;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(warnings.length ? { contacts, warnings } : { contacts }, null, 2),
            },
          ],
        };
      },
    },
  ];
}

export const contactsTools = createContactsTools();
