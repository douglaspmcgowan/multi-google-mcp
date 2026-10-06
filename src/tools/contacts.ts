import type { people_v1 } from "@googleapis/people";
import { getAuthenticatedClient } from "../auth.js";
import { getAccountNames } from "../config.js";
import { grantedScopes, withScope, type ScopeLookup } from "../scopes.js";
import type { ToolDef } from "./types.js";

type PeopleClient = people_v1.People;

export const CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";
export const OTHER_CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts.other.readonly";
export const CONTACTS_WRITE_SCOPE = "https://www.googleapis.com/auth/contacts";

const READ_MASK = "names,emailAddresses,phoneNumbers";
const FULL_MASK = "names,emailAddresses,phoneNumbers,organizations,biographies,memberships";

function asText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function toDetail(person: people_v1.Schema$Person | undefined) {
  return {
    resourceName: person?.resourceName,
    etag: person?.etag,
    names: (person?.names || []).map((n) => n.displayName).filter(Boolean),
    emails: (person?.emailAddresses || []).map((e) => e.value).filter(Boolean),
    phones: (person?.phoneNumbers || []).map((p) => p.value).filter(Boolean),
    organizations: (person?.organizations || []).map((o) => ({ name: o.name, title: o.title })),
    notes: (person?.biographies || []).map((b) => b.value).filter(Boolean),
    groups: (person?.memberships || []).map((m) => m.contactGroupMembership?.contactGroupResourceName).filter(Boolean),
  };
}

interface ContactFields {
  given_name?: string;
  family_name?: string;
  emails?: string[];
  phones?: string[];
  organization?: string;
  job_title?: string;
  notes?: string;
}

const contactFieldProps = {
  given_name: { type: "string", description: "First name" },
  family_name: { type: "string", description: "Last name" },
  emails: { type: "array", items: { type: "string" }, description: "Email addresses (replaces the existing list on update)" },
  phones: { type: "array", items: { type: "string" }, description: "Phone numbers (replaces the existing list on update)" },
  organization: { type: "string", description: "Company or organization name" },
  job_title: { type: "string", description: "Job title" },
  notes: { type: "string", description: "Free-text note" },
};

/** Maps tool arguments to a Person body plus the People API field names that were set. */
export function buildPerson(args: ContactFields): { person: people_v1.Schema$Person; fields: string[] } {
  const person: people_v1.Schema$Person = {};
  const fields: string[] = [];
  if (args.given_name !== undefined || args.family_name !== undefined) {
    person.names = [{ givenName: args.given_name, familyName: args.family_name }];
    fields.push("names");
  }
  if (args.emails !== undefined) {
    person.emailAddresses = args.emails.map((value) => ({ value }));
    fields.push("emailAddresses");
  }
  if (args.phones !== undefined) {
    person.phoneNumbers = args.phones.map((value) => ({ value }));
    fields.push("phoneNumbers");
  }
  if (args.organization !== undefined || args.job_title !== undefined) {
    person.organizations = [{ name: args.organization, title: args.job_title }];
    fields.push("organizations");
  }
  if (args.notes !== undefined) {
    person.biographies = [{ value: args.notes, contentType: "TEXT_PLAIN" }];
    fields.push("biographies");
  }
  return { person, fields };
}

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
  const account = { type: "string" as const, description: "Account label" };
  const resourceName = {
    type: "string" as const,
    description: "Contact resource name from contacts_list or contacts_search, e.g. people/c123",
  };
  const acct = accountDescription(getAccounts);
  const runRead = <T>(a: string, fn: () => Promise<T>) =>
    withScope(a, [CONTACTS_SCOPE, CONTACTS_WRITE_SCOPE], lookup, fn);
  const runWrite = <T>(a: string, fn: () => Promise<T>) => withScope(a, [CONTACTS_WRITE_SCOPE], lookup, fn);

  const more: ToolDef[] = [
    {
      name: "contacts_list",
      readOnly: true,
      description: `List an account's saved contacts (names, emails, phones, organizations), one page at a time. Pass next_page_token from the previous result for more. ${acct}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          page_size: { type: "number", description: "Contacts per page, 1-1000 (default 100)" },
          page_token: { type: "string", description: "next_page_token from the previous call" },
        },
        required: ["account"],
      },
      handler: async (args: { account: string; page_size?: number; page_token?: string }) =>
        runRead(args.account, async () => {
          const people = await getClient(args.account);
          const res = await people.people.connections.list({
            resourceName: "people/me",
            personFields: FULL_MASK,
            pageSize: args.page_size || 100,
            pageToken: args.page_token,
          });
          return asText({
            contacts: (res.data.connections || []).map(toDetail),
            next_page_token: res.data.nextPageToken || null,
            total_items: res.data.totalItems,
          });
        }),
    },
    {
      name: "contacts_get",
      readOnly: true,
      description: `Get one saved contact in full, including its etag and group memberships. ${acct}`,
      inputSchema: { type: "object" as const, properties: { account, resource_name: resourceName }, required: ["account", "resource_name"] },
      handler: async (args: { account: string; resource_name: string }) =>
        runRead(args.account, async () => {
          const people = await getClient(args.account);
          const res = await people.people.get({ resourceName: args.resource_name, personFields: FULL_MASK });
          return asText(toDetail(res.data));
        }),
    },
    {
      name: "contacts_create",
      readOnly: false,
      description: `Create a saved contact. Provide at least one field. ${acct}`,
      inputSchema: { type: "object" as const, properties: { account, ...contactFieldProps }, required: ["account"] },
      handler: async (args: { account: string } & ContactFields) =>
        runWrite(args.account, async () => {
          const { person, fields } = buildPerson(args);
          if (fields.length === 0) throw new Error("Provide at least one contact field.");
          const people = await getClient(args.account);
          const res = await people.people.createContact({ personFields: FULL_MASK, requestBody: person });
          return asText(toDetail(res.data));
        }),
    },
    {
      name: "contacts_update",
      readOnly: false,
      description:
        "Change fields on a saved contact. Only the fields you pass change; a list field (emails, phones) is replaced whole. " +
        `The API needs the contact's current etag; it is fetched for you unless you pass etag. ${acct}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          resource_name: resourceName,
          etag: { type: "string", description: "Etag from contacts_get (optional; fetched when omitted)" },
          ...contactFieldProps,
        },
        required: ["account", "resource_name"],
      },
      handler: async (args: { account: string; resource_name: string; etag?: string } & ContactFields) =>
        runWrite(args.account, async () => {
          const { person, fields } = buildPerson(args);
          if (fields.length === 0) throw new Error("Provide at least one field to change.");
          const people = await getClient(args.account);
          let etag = args.etag;
          if (!etag) {
            const current = await people.people.get({ resourceName: args.resource_name, personFields: "metadata" });
            etag = current.data.etag || undefined;
          }
          if (!etag) throw new Error("Could not determine the contact's etag; pass etag from contacts_get.");
          person.etag = etag;
          const res = await people.people.updateContact({
            resourceName: args.resource_name,
            updatePersonFields: fields.join(","),
            personFields: FULL_MASK,
            requestBody: person,
          });
          return asText(toDetail(res.data));
        }),
    },
    {
      name: "contacts_delete",
      readOnly: false,
      description: `DESTRUCTIVE: permanently deletes a saved contact from the account. It cannot be undone through this server. ${acct}`,
      inputSchema: { type: "object" as const, properties: { account, resource_name: resourceName }, required: ["account", "resource_name"] },
      handler: async (args: { account: string; resource_name: string }) =>
        runWrite(args.account, async () => {
          const people = await getClient(args.account);
          await people.people.deleteContact({ resourceName: args.resource_name });
          return asText({ deleted: args.resource_name });
        }),
    },
    {
      name: "contacts_list_groups",
      readOnly: true,
      description: `List contact groups (labels) with their resource names and member counts. ${acct}`,
      inputSchema: { type: "object" as const, properties: { account }, required: ["account"] },
      handler: async (args: { account: string }) =>
        runRead(args.account, async () => {
          const people = await getClient(args.account);
          const res = await people.contactGroups.list({ pageSize: 200 });
          return asText(
            (res.data.contactGroups || []).map((g) => ({
              resourceName: g.resourceName,
              name: g.name,
              groupType: g.groupType,
              memberCount: g.memberCount,
            }))
          );
        }),
    },
    {
      name: "contacts_create_group",
      readOnly: false,
      description: `Create a contact group (label). ${acct}`,
      inputSchema: {
        type: "object" as const,
        properties: { account, name: { type: "string", description: "Group name" } },
        required: ["account", "name"],
      },
      handler: async (args: { account: string; name: string }) =>
        runWrite(args.account, async () => {
          const people = await getClient(args.account);
          const res = await people.contactGroups.create({ requestBody: { contactGroup: { name: args.name } } });
          return asText({ resourceName: res.data.resourceName, name: res.data.name });
        }),
    },
  ];

  const groupTool = (name: string, verb: string, key: "resourceNamesToAdd" | "resourceNamesToRemove"): ToolDef => ({
    name,
    readOnly: false,
    description: `${verb} one or more saved contacts in a contact group. ${acct}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account,
        group_resource_name: { type: "string", description: "Group resource name from contacts_list_groups, e.g. contactGroups/abc" },
        contact_resource_names: { type: "array", items: { type: "string" }, description: "Contact resource names, e.g. people/c123" },
      },
      required: ["account", "group_resource_name", "contact_resource_names"],
    },
    handler: async (args: { account: string; group_resource_name: string; contact_resource_names: string[] }) =>
      runWrite(args.account, async () => {
        if (!args.contact_resource_names?.length) throw new Error("Provide at least one contact resource name.");
        const people = await getClient(args.account);
        const res = await people.contactGroups.members.modify({
          resourceName: args.group_resource_name,
          requestBody: { [key]: args.contact_resource_names },
        });
        return asText({
          group: args.group_resource_name,
          notFound: res.data.notFoundResourceNames || [],
          canNotRemoveLast: res.data.canNotRemoveLastContactGroupResourceNames || [],
        });
      }),
  });
  more.push(groupTool("contacts_add_to_group", "Add", "resourceNamesToAdd"));
  more.push(groupTool("contacts_remove_from_group", "Remove", "resourceNamesToRemove"));
  more.push({
    name: "contacts_copy_other_to_my_contacts",
    readOnly: false,
    description:
      "Copy an 'other contact' (someone the account has emailed) into saved contacts. Needs both the contacts and " +
      `contacts.other.readonly scopes. ${acct}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account,
        resource_name: { type: "string", description: "Other-contact resource name from contacts_search, e.g. otherContacts/c123" },
      },
      required: ["account", "resource_name"],
    },
    handler: async (args: { account: string; resource_name: string }) =>
      withScope(args.account, [OTHER_CONTACTS_SCOPE], lookup, () =>
        runWrite(args.account, async () => {
          const people = await getClient(args.account);
          const res = await people.otherContacts.copyOtherContactToMyContactsGroup({
            resourceName: args.resource_name,
            requestBody: { copyMask: "names,emailAddresses,phoneNumbers", readMask: FULL_MASK },
          });
          return asText(toDetail(res.data));
        })
      ),
  });

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
        const sources: Array<[string[], "contacts" | "other", () => Promise<people_v1.Schema$Person[]>]> = [
          [
            [CONTACTS_SCOPE, CONTACTS_WRITE_SCOPE],
            "contacts",
            async () => {
              const res = await people.people.searchContacts({ query: args.query, readMask: READ_MASK, pageSize });
              return (res.data.results || []).map((r) => r.person!).filter(Boolean);
            },
          ],
          [
            [OTHER_CONTACTS_SCOPE],
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
            const persons = await withScope(args.account, scope, lookup, fn);
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
    ...more,
  ];
}

export const contactsTools = createContactsTools();
