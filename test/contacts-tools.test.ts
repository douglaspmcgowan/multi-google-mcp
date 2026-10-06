import assert from "node:assert/strict";
import test from "node:test";
import { buildPerson, createContactsTools } from "../src/tools/contacts.js";

const READONLY = ["https://www.googleapis.com/auth/contacts.readonly"];
const FULL = ["https://www.googleapis.com/auth/contacts", "https://www.googleapis.com/auth/contacts.other.readonly"];

function fake(lookup: (a: string) => string[] | undefined = () => undefined) {
  const calls: Record<string, any> = {};
  const person = { resourceName: "people/c1", etag: "E1", names: [{ displayName: "Ada" }], emailAddresses: [{ value: "a@x.com" }] };
  const client: any = {
    people: {
      connections: { list: async (r: any) => ((calls.list = r), { data: { connections: [person], nextPageToken: "N2", totalItems: 5 } }) },
      get: async (r: any) => ((calls.get = r), { data: person }),
      createContact: async (r: any) => ((calls.create = r), { data: person }),
      updateContact: async (r: any) => ((calls.update = r), { data: person }),
      deleteContact: async (r: any) => ((calls.delete = r), { data: {} }),
    },
    contactGroups: {
      list: async (r: any) => ((calls.groups = r), { data: { contactGroups: [{ resourceName: "contactGroups/g1", name: "Friends", memberCount: 2 }] } }),
      create: async (r: any) => ((calls.createGroup = r), { data: { resourceName: "contactGroups/g2", name: r.requestBody.contactGroup.name } }),
      members: { modify: async (r: any) => ((calls.modify = r), { data: { notFoundResourceNames: ["people/zz"] } }) },
    },
    otherContacts: {
      copyOtherContactToMyContactsGroup: async (r: any) => ((calls.copy = r), { data: person }),
    },
  };
  const tools = createContactsTools(() => client, () => ["me"], lookup);
  const tool = (name: string) => {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `missing ${name}`);
    return t;
  };
  const call = async (name: string, args: any) => JSON.parse((await tool(name).handler(args)).content[0].text);
  return { calls, call, tool, tools };
}

test("every new contacts tool is registered with the right readOnly flag", () => {
  const { tools } = fake();
  const flags = Object.fromEntries(tools.map((t) => [t.name, t.readOnly]));
  assert.deepEqual(flags, {
    contacts_search: true,
    contacts_search_directory: true,
    contacts_list_directory: true,
    contacts_list: true,
    contacts_get: true,
    contacts_create: false,
    contacts_update: false,
    contacts_delete: false,
    contacts_list_groups: true,
    contacts_create_group: false,
    contacts_add_to_group: false,
    contacts_remove_from_group: false,
    contacts_copy_other_to_my_contacts: false,
  });
});

test("contacts_delete is described as destructive", () => {
  assert.match(fake().tool("contacts_delete").description, /DESTRUCTIVE/);
});

test("contacts_list pages connections of people/me", async () => {
  const { calls, call } = fake();
  const out = await call("contacts_list", { account: "me", page_size: 50, page_token: "N1" });
  assert.equal(calls.list.resourceName, "people/me");
  assert.equal(calls.list.pageSize, 50);
  assert.equal(calls.list.pageToken, "N1");
  assert.match(calls.list.personFields, /organizations/);
  assert.equal(out.next_page_token, "N2");
  assert.equal(out.contacts[0].resourceName, "people/c1");
  assert.deepEqual(out.contacts[0].emails, ["a@x.com"]);
  await call("contacts_list", { account: "me" });
  assert.equal(calls.list.pageSize, 100);
});

test("contacts_get requests the named resource", async () => {
  const { calls, call } = fake();
  const out = await call("contacts_get", { account: "me", resource_name: "people/c1" });
  assert.equal(calls.get.resourceName, "people/c1");
  assert.equal(out.etag, "E1");
});

test("buildPerson maps arguments and reports the fields it set", () => {
  const { person, fields } = buildPerson({
    given_name: "Ada",
    family_name: "L",
    emails: ["a@x.com"],
    phones: ["555"],
    organization: "Acme",
    notes: "hi",
  });
  assert.deepEqual(fields, ["names", "emailAddresses", "phoneNumbers", "organizations", "biographies"]);
  assert.deepEqual(person.names, [{ givenName: "Ada", familyName: "L" }]);
  assert.deepEqual(person.emailAddresses, [{ value: "a@x.com" }]);
  assert.deepEqual(buildPerson({}).fields, []);
});

test("contacts_create sends a Person body and refuses an empty one", async () => {
  const { calls, call } = fake();
  await call("contacts_create", { account: "me", given_name: "Ada", emails: ["a@x.com"] });
  assert.deepEqual(calls.create.requestBody.names, [{ givenName: "Ada", familyName: undefined }]);
  assert.deepEqual(calls.create.requestBody.emailAddresses, [{ value: "a@x.com" }]);
  await assert.rejects(() => call("contacts_create", { account: "me" }), /at least one/);
});

test("contacts_update fetches the etag, masks only changed fields, and honours a supplied etag", async () => {
  const { calls, call } = fake();
  await call("contacts_update", { account: "me", resource_name: "people/c1", phones: ["555"] });
  assert.equal(calls.get.personFields, "metadata");
  assert.equal(calls.update.resourceName, "people/c1");
  assert.equal(calls.update.updatePersonFields, "phoneNumbers");
  assert.equal(calls.update.requestBody.etag, "E1");
  delete calls.get;
  await call("contacts_update", { account: "me", resource_name: "people/c1", notes: "n", etag: "MINE" });
  assert.equal(calls.get, undefined);
  assert.equal(calls.update.requestBody.etag, "MINE");
  assert.equal(calls.update.updatePersonFields, "biographies");
  await assert.rejects(() => call("contacts_update", { account: "me", resource_name: "people/c1" }), /at least one/);
});

test("contacts_delete sends deleteContact", async () => {
  const { calls, call } = fake();
  assert.deepEqual(await call("contacts_delete", { account: "me", resource_name: "people/c1" }), { deleted: "people/c1" });
  assert.equal(calls.delete.resourceName, "people/c1");
});

test("group tools list, create and modify membership", async () => {
  const { calls, call } = fake();
  const groups = await call("contacts_list_groups", { account: "me" });
  assert.equal(groups[0].name, "Friends");
  const created = await call("contacts_create_group", { account: "me", name: "Team" });
  assert.deepEqual(calls.createGroup.requestBody, { contactGroup: { name: "Team" } });
  assert.equal(created.resourceName, "contactGroups/g2");
  const added = await call("contacts_add_to_group", {
    account: "me",
    group_resource_name: "contactGroups/g1",
    contact_resource_names: ["people/c1"],
  });
  assert.equal(calls.modify.resourceName, "contactGroups/g1");
  assert.deepEqual(calls.modify.requestBody, { resourceNamesToAdd: ["people/c1"] });
  assert.deepEqual(added.notFound, ["people/zz"]);
  await call("contacts_remove_from_group", {
    account: "me",
    group_resource_name: "contactGroups/g1",
    contact_resource_names: ["people/c1"],
  });
  assert.deepEqual(calls.modify.requestBody, { resourceNamesToRemove: ["people/c1"] });
  await assert.rejects(
    () => call("contacts_add_to_group", { account: "me", group_resource_name: "contactGroups/g1", contact_resource_names: [] }),
    /at least one/
  );
});

test("contacts_copy_other_to_my_contacts copies an other contact", async () => {
  const { calls, call } = fake();
  await call("contacts_copy_other_to_my_contacts", { account: "me", resource_name: "otherContacts/c9" });
  assert.equal(calls.copy.resourceName, "otherContacts/c9");
  assert.match(calls.copy.requestBody.copyMask, /emailAddresses/);
});

test("scope refusal: a read-only token can read but every write names the re-auth command", async () => {
  const { call } = fake(() => READONLY);
  await call("contacts_list", { account: "me" });
  await call("contacts_get", { account: "me", resource_name: "people/c1" });
  await call("contacts_list_groups", { account: "me" });
  const writes: Array<[string, any]> = [
    ["contacts_create", { given_name: "A" }],
    ["contacts_update", { resource_name: "people/c1", notes: "x" }],
    ["contacts_delete", { resource_name: "people/c1" }],
    ["contacts_create_group", { name: "G" }],
    ["contacts_add_to_group", { group_resource_name: "contactGroups/g", contact_resource_names: ["people/c1"] }],
    ["contacts_remove_from_group", { group_resource_name: "contactGroups/g", contact_resource_names: ["people/c1"] }],
    ["contacts_copy_other_to_my_contacts", { resource_name: "otherContacts/c9" }],
  ];
  for (const [name, args] of writes) {
    await assert.rejects(() => call(name, { account: "me", ...args }), /npm run add-account -- --account me/, name);
  }
});

test("full-scope token passes the scope check for writes", async () => {
  const { call } = fake(() => FULL);
  await call("contacts_delete", { account: "me", resource_name: "people/c1" });
  await call("contacts_copy_other_to_my_contacts", { account: "me", resource_name: "otherContacts/c9" });
});
