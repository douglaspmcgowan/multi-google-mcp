import assert from "node:assert/strict";
import test from "node:test";
import { createContactsTools, CONTACTS_SCOPE, OTHER_CONTACTS_SCOPE } from "../src/tools/contacts.js";
import { SCOPES } from "../src/config.js";

const person = (name: string, email: string, phone?: string) => ({
  names: [{ displayName: name }],
  emailAddresses: [{ value: email }],
  phoneNumbers: phone ? [{ value: phone }] : [],
});

function fake(opts: { otherFails?: boolean } = {}) {
  const calls: Record<string, any> = {};
  const client: any = {
    people: {
      searchContacts: async (r: any) => ((calls.contacts = r), { data: { results: [{ person: person("Ada Lovelace", "ada@x.com", "555-1") }] } }),
    },
    otherContacts: {
      search: async (r: any) => {
        calls.other = r;
        if (opts.otherFails) throw new Error("Request had insufficient authentication scopes.");
        return { data: { results: [{ person: person("Bob", "bob@x.com") }] } };
      },
    },
  };
  return { calls, tool: createContactsTools(() => client, () => ["me"], () => undefined)[0] };
}

test("contacts scopes are requested", () => {
  assert.ok(SCOPES.includes(CONTACTS_SCOPE) && SCOPES.includes(OTHER_CONTACTS_SCOPE));
});

test("contacts_search queries both sources and returns names, emails and phones", async () => {
  const { calls, tool } = fake();
  assert.equal(tool.readOnly, true);
  const out = JSON.parse((await tool.handler({ account: "me", query: "ada" })).content[0].text);
  assert.equal(calls.contacts.query, "ada");
  assert.equal(calls.contacts.readMask, "names,emailAddresses,phoneNumbers");
  assert.equal(calls.other.query, "ada");
  assert.deepEqual(out.contacts, [
    { source: "contacts", names: ["Ada Lovelace"], emails: ["ada@x.com"], phones: ["555-1"] },
    { source: "other", names: ["Bob"], emails: ["bob@x.com"], phones: [] },
  ]);
});

test("one source lacking its scope does not hide the other; both lacking is an error naming the fix", async () => {
  const { tool } = fake({ otherFails: true });
  const out = JSON.parse((await tool.handler({ account: "me", query: "x" })).content[0].text);
  assert.equal(out.contacts.length, 1);
  assert.match(out.warnings[0], /npm run add-account -- --account me/);

  const none = createContactsTools(() => ({}) as any, () => ["me"], () => ["https://www.googleapis.com/auth/gmail.modify"])[0];
  await assert.rejects(() => none.handler({ account: "house", query: "x" }), /npm run add-account -- --account house/);
});
