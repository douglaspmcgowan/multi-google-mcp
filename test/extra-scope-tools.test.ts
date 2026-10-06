import assert from "node:assert/strict";
import test from "node:test";
import { createChatTools, pinName } from "../src/tools/chat.js";
import { createMeetTools, conferenceName, childName } from "../src/tools/meet.js";
import { createGmailExtraTools } from "../src/tools/gmail.js";
import { createContactsTools } from "../src/tools/contacts.js";
import { SCOPES, READ_ONLY_SCOPES } from "../src/config.js";
import { ScopeError } from "../src/scopes.js";

const A = "https://www.googleapis.com/auth/";
type Call = { m: string; req: any };
const json = (r: any) => JSON.parse(r.content[0].text);

function recorder(calls: Call[]) {
  return (m: string, data: any = {}) => async (req: any) => {
    calls.push({ m, req });
    return { data };
  };
}

// ---------- Chat ----------
function chatSetup(scopes: string[] | undefined = SCOPES) {
  const calls: Call[] = [];
  const rec = recorder(calls);
  const client: any = {
    spaces: {
      delete: rec("spaces.delete"),
      messagePins: {
        list: rec("pins.list", { messagePins: [{ name: "spaces/A/messagePins/m1", message: "spaces/A/messages/m1" }], nextPageToken: "N" }),
        create: rec("pins.create", { name: "spaces/A/messagePins/m1" }),
        delete: rec("pins.delete"),
      },
      messages: { search: rec("messages.search", { results: [{ message: { name: "spaces/A/messages/1", text: "hi" } }], nextPageToken: "T" }) },
    },
    users: {
      spaces: {
        getSpaceReadState: rec("readstate.get", { lastReadTime: "2026-01-01T00:00:00Z" }),
        updateSpaceReadState: rec("readstate.update", { lastReadTime: "x" }),
        spaceNotificationSetting: {
          get: rec("notif.get", { notificationSetting: "ALL" }),
          patch: rec("notif.patch", { muteSetting: "MUTED" }),
        },
        threads: { getThreadReadState: rec("thread.get", { lastReadTime: "t" }) },
      },
    },
  };
  const tools = createChatTools(() => client, () => ["b"], () => scopes);
  const call = async (name: string, args: any) => {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `missing ${name}`);
    return json(await t.handler({ account: "b", ...args } as any));
  };
  return { calls, tools, call };
}

test("chat extras: names and readOnly flags", () => {
  const { tools } = chatSetup();
  const flags = Object.fromEntries(tools.map((t) => [t.name, t.readOnly]));
  const expected = {
    chat_list_pins: true,
    chat_pin_message: false,
    chat_unpin_message: false,
    chat_delete_space: false,
    chat_get_read_state: true,
    chat_mark_space_read: false,
    chat_get_notification_setting: true,
    chat_set_notification_setting: false,
    chat_search_messages: true,
  };
  for (const [n, ro] of Object.entries(expected)) assert.equal(flags[n], ro, n);
});

test("pinName accepts full names and bare ids", () => {
  assert.equal(pinName("spaces/A/messagePins/p", undefined), "spaces/A/messagePins/p");
  assert.equal(pinName("p", "A"), "spaces/A/messagePins/p");
  assert.throws(() => pinName("p"), /full pin name/);
});

test("chat pins: list, pin, unpin request shapes", async () => {
  const { calls, call } = chatSetup();
  const listed = await call("chat_list_pins", { space: "A", page_size: 5 });
  assert.deepEqual(calls[0].req, { parent: "spaces/A", pageSize: 5 });
  assert.equal(listed.next_page_token, "N");
  await call("chat_pin_message", { message: "spaces/A/messages/m1" });
  assert.deepEqual(calls[1].req, { parent: "spaces/A", requestBody: { message: "spaces/A/messages/m1" } });
  await call("chat_unpin_message", { message: "spaces/A/messages/m1" });
  assert.deepEqual(calls[2].req, { name: "spaces/A/messagePins/m1" });
  await call("chat_unpin_message", { pin: "m2", space: "A" });
  assert.deepEqual(calls[3].req, { name: "spaces/A/messagePins/m2" });
  await assert.rejects(call("chat_unpin_message", {}), /pass pin, or message/);
});

test("chat_delete_space calls spaces.delete and needs chat.delete", async () => {
  const { calls, call } = chatSetup();
  const out = await call("chat_delete_space", { space: "A" });
  assert.deepEqual(calls[0], { m: "spaces.delete", req: { name: "spaces/A" } });
  assert.deepEqual(out, { deleted: "spaces/A" });
  const old = chatSetup([`${A}chat.spaces`, `${A}chat.messages`]);
  await assert.rejects(old.call("chat_delete_space", { space: "A" }), ScopeError);
  assert.equal(old.calls.length, 0);
});

test("chat read state: get space, get thread, mark read", async () => {
  const { calls, call } = chatSetup();
  await call("chat_get_read_state", { space: "A" });
  assert.deepEqual(calls[0].req, { name: "users/me/spaces/A/spaceReadState" });
  await call("chat_get_read_state", { space: "A", thread: "spaces/A/threads/T" });
  assert.deepEqual(calls[1].req, { name: "users/me/spaces/A/threads/T/threadReadState" });
  await call("chat_mark_space_read", { space: "A", read_time: "2026-02-03T04:05:06Z" });
  assert.deepEqual(calls[2].req, {
    name: "users/me/spaces/A/spaceReadState",
    updateMask: "lastReadTime",
    requestBody: { lastReadTime: "2026-02-03T04:05:06.000Z" },
  });
  await call("chat_mark_space_read", { space: "A" });
  assert.match(calls[3].req.requestBody.lastReadTime, /^\d{4}-\d\d-\d\dT/);
  await assert.rejects(call("chat_mark_space_read", { space: "A", read_time: "nope" }), /valid timestamp/);
  const old = chatSetup([`${A}chat.spaces`]);
  await assert.rejects(old.call("chat_get_read_state", { space: "A" }), ScopeError);
});

test("chat notification settings: get, set with mask, validation, scope refusal", async () => {
  const { calls, call } = chatSetup();
  await call("chat_get_notification_setting", { space: "A" });
  assert.deepEqual(calls[0].req, { name: "users/me/spaces/A/spaceNotificationSetting" });
  await call("chat_set_notification_setting", { space: "A", mute_setting: "MUTED", notification_setting: "OFF" });
  assert.deepEqual(calls[1].req, {
    name: "users/me/spaces/A/spaceNotificationSetting",
    updateMask: "notification_setting,mute_setting",
    requestBody: { notificationSetting: "OFF", muteSetting: "MUTED" },
  });
  await assert.rejects(call("chat_set_notification_setting", { space: "A" }), /pass notification_setting/);
  await assert.rejects(call("chat_set_notification_setting", { space: "A", mute_setting: "LOUD" }), /mute_setting must be/);
  const old = chatSetup([`${A}chat.spaces`]);
  await assert.rejects(old.call("chat_set_notification_setting", { space: "A", mute_setting: "MUTED" }), ScopeError);
});

test("chat_search_messages searches spaces/- with the filter", async () => {
  const { calls, call } = chatSetup();
  const out = await call("chat_search_messages", { query: "invoice", page_size: 10 });
  assert.deepEqual(calls[0].req, { parent: "spaces/-", requestBody: { filter: "invoice", pageSize: 10 } });
  assert.equal(out.results[0].text, "hi");
  assert.equal(out.next_page_token, "T");
  await assert.rejects(call("chat_search_messages", { query: "  " }), /query is empty/);
});

// ---------- Meet ----------
function meetSetup(scopes: string[] | undefined = SCOPES) {
  const calls: Call[] = [];
  const rec = recorder(calls);
  let entryPage = 0;
  const client: any = {
    conferenceRecords: {
      list: rec("cr.list", { conferenceRecords: [{ name: "conferenceRecords/c1" }], nextPageToken: "N" }),
      get: rec("cr.get", { name: "conferenceRecords/c1" }),
      participants: {
        list: rec("p.list", { participants: [{ name: "conferenceRecords/c1/participants/p1" }] }),
        participantSessions: { list: rec("ps.list", { participantSessions: [{ name: "s1" }] }) },
      },
      recordings: { list: rec("rec.list", { recordings: [{ name: "r1" }] }) },
      transcripts: {
        list: rec("t.list", { transcripts: [{ name: "t1" }] }),
        entries: {
          list: async (req: any) => {
            calls.push({ m: "entries.list", req });
            entryPage++;
            return { data: { transcriptEntries: [{ text: `line${entryPage}` }], nextPageToken: entryPage < 3 ? `P${entryPage}` : "" } };
          },
        },
      },
    },
    spaces: {},
  };
  const tools = createMeetTools(() => client, () => ["me"], () => scopes);
  const call = async (name: string, args: any) => {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `missing ${name}`);
    return json(await t.handler({ account: "me", ...args }));
  };
  return { calls, tools, call };
}

test("meet record tools are all read-only; scope meetings.space.readonly is requested", () => {
  const { tools } = meetSetup();
  for (const n of [
    "meet_list_conference_records", "meet_get_conference_record", "meet_list_participants",
    "meet_list_participant_sessions", "meet_list_recordings", "meet_list_transcripts", "meet_list_transcript_entries",
  ]) assert.equal(tools.find((t) => t.name === n)?.readOnly, true, n);
  assert.ok(SCOPES.includes(`${A}meetings.space.readonly`));
  assert.ok(READ_ONLY_SCOPES.includes(`${A}meetings.space.readonly`));
});

test("meet name helpers", () => {
  assert.equal(conferenceName("c1"), "conferenceRecords/c1");
  assert.equal(conferenceName("conferenceRecords/c1"), "conferenceRecords/c1");
  assert.equal(childName("participant", "p1", "c1"), "conferenceRecords/c1/participants/p1");
  assert.equal(childName("transcript", "conferenceRecords/c1/transcripts/t1"), "conferenceRecords/c1/transcripts/t1");
  assert.throws(() => childName("transcript", "t1"), /full transcript name/);
  assert.throws(() => conferenceName(" "), /required/);
});

test("meet list and get shape requests", async () => {
  const { calls, call } = meetSetup();
  const list = await call("meet_list_conference_records", { filter: 'space.meeting_code = "abc"', page_size: 7 });
  assert.deepEqual(calls[0].req, { pageSize: 7, filter: 'space.meeting_code = "abc"' });
  assert.equal(list.next_page_token, "N");
  await call("meet_get_conference_record", { conference_record: "c1" });
  assert.deepEqual(calls[1].req, { name: "conferenceRecords/c1" });
  await call("meet_list_participants", { conference_record: "c1", filter: "latest_end_time IS NULL" });
  assert.deepEqual(calls[2].req, { parent: "conferenceRecords/c1", filter: "latest_end_time IS NULL" });
  await call("meet_list_participant_sessions", { participant: "p1", conference_record: "c1" });
  assert.deepEqual(calls[3].req, { parent: "conferenceRecords/c1/participants/p1" });
  const rec = await call("meet_list_recordings", { conference_record: "c1" });
  assert.deepEqual(calls[4].req, { parent: "conferenceRecords/c1" });
  assert.equal(rec.recordings.length, 1);
  await call("meet_list_transcripts", { conference_record: "c1" });
  assert.deepEqual(calls[5].req, { parent: "conferenceRecords/c1" });
});

test("meet_list_transcript_entries: one page, and all pages", async () => {
  const one = meetSetup();
  const first = await one.call("meet_list_transcript_entries", { transcript: "t1", conference_record: "c1", page_size: 50 });
  assert.deepEqual(one.calls[0].req, { parent: "conferenceRecords/c1/transcripts/t1", pageSize: 50 });
  assert.equal(first.entries.length, 1);
  assert.equal(first.next_page_token, "P1");
  const all = meetSetup();
  const out = await all.call("meet_list_transcript_entries", { transcript: "conferenceRecords/c1/transcripts/t1", all_pages: true });
  assert.deepEqual(out.entries.map((e: any) => e.text), ["line1", "line2", "line3"]);
  assert.equal(out.next_page_token, null);
  assert.equal(all.calls[1].req.pageToken, "P1");
});

test("meet record tools accept created or readonly scope and refuse neither", async () => {
  await assert.doesNotReject(meetSetup([`${A}meetings.space.created`]).call("meet_list_conference_records", {}));
  await assert.doesNotReject(meetSetup([`${A}meetings.space.readonly`]).call("meet_list_conference_records", {}));
  await assert.rejects(meetSetup([`${A}drive`]).call("meet_list_conference_records", {}), ScopeError);
});

// ---------- Gmail settings ----------
function gmailSetup(scopes: string[] | undefined = [`${A}gmail.modify`, `${A}gmail.settings.basic`]) {
  const calls: Call[] = [];
  const rec = recorder(calls);
  const gmail = {
    users: {
      labels: { list: async () => ({ data: { labels: [] } }) },
      settings: {
        forwardingAddresses: {
          list: rec("fa.list", { forwardingAddresses: [{ forwardingEmail: "x@y.z", verificationStatus: "accepted" }] }),
          get: rec("fa.get", { forwardingEmail: "x@y.z" }),
        },
        getAutoForwarding: rec("af.get", { enabled: false }),
        getImap: rec("imap.get", { enabled: true, autoExpunge: true, expungeBehavior: "archive", maxFolderSize: 0 }),
        updateImap: rec("imap.update", { enabled: false }),
        getPop: rec("pop.get", { accessWindow: "disabled", disposition: "leaveInInbox" }),
        updatePop: rec("pop.update", { accessWindow: "allMail" }),
        getLanguage: rec("lang.get", { displayLanguage: "en" }),
        updateLanguage: rec("lang.update", { displayLanguage: "fr" }),
        filters: { create: rec("filters.create", { id: "f1" }) },
      },
    },
  };
  const tools = createGmailExtraTools(async () => gmail, () => scopes);
  const call = async (name: string, args: any) => {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `missing ${name}`);
    return json(await t.handler({ account: "x", ...args }));
  };
  return { calls, tools, call };
}

test("gmail settings tools: readOnly flags", () => {
  const { tools } = gmailSetup();
  const flags = Object.fromEntries(tools.map((t) => [t.name, t.readOnly]));
  assert.deepEqual(
    {
      l: flags.gmail_list_forwarding_addresses, g: flags.gmail_get_forwarding_address, a: flags.gmail_get_auto_forwarding,
      gi: flags.gmail_get_imap, ui: flags.gmail_update_imap, gp: flags.gmail_get_pop, up: flags.gmail_update_pop,
      gl: flags.gmail_get_language, ul: flags.gmail_update_language,
    },
    { l: true, g: true, a: true, gi: true, ui: false, gp: true, up: false, gl: true, ul: false }
  );
  for (const n of ["gmail_create_forwarding_address", "gmail_delete_forwarding_address", "gmail_set_auto_forwarding", "gmail_list_delegates"]) {
    assert.equal(tools.find((t) => t.name === n), undefined, `${n} must not exist: service-account-only`);
  }
});

test("gmail forwarding reads and getters hit the right methods", async () => {
  const { calls, call } = gmailSetup();
  const list = await call("gmail_list_forwarding_addresses", {});
  assert.equal(list.forwardingAddresses[0].forwardingEmail, "x@y.z");
  assert.deepEqual(calls[0].req, { userId: "me" });
  await call("gmail_get_forwarding_address", { forwarding_email: "x@y.z" });
  assert.deepEqual(calls[1].req, { userId: "me", forwardingEmail: "x@y.z" });
  await call("gmail_get_auto_forwarding", {});
  await call("gmail_get_imap", {});
  await call("gmail_get_pop", {});
  await call("gmail_get_language", {});
  assert.deepEqual(calls.slice(2).map((c) => c.m), ["af.get", "imap.get", "pop.get", "lang.get"]);
  await assert.rejects(call("gmail_get_forwarding_address", {}), /forwarding_email is required/);
});

test("gmail reads also work with gmail.modify alone; writes need settings.basic", async () => {
  const modifyOnly = gmailSetup([`${A}gmail.modify`]);
  await assert.doesNotReject(modifyOnly.call("gmail_get_imap", {}));
  await assert.rejects(modifyOnly.call("gmail_update_imap", { enabled: false }), ScopeError);
  await assert.rejects(modifyOnly.call("gmail_update_language", { display_language: "fr" }), ScopeError);
});

test("gmail_update_imap merges onto current settings and validates", async () => {
  const { calls, call } = gmailSetup();
  await call("gmail_update_imap", { enabled: false });
  assert.deepEqual(calls[1].req, {
    userId: "me",
    requestBody: { enabled: false, autoExpunge: true, expungeBehavior: "archive", maxFolderSize: 0 },
  });
  await assert.rejects(call("gmail_update_imap", {}), /at least one/);
  await assert.rejects(call("gmail_update_imap", { expunge_behavior: "nuke" }), /expunge_behavior must be/);
  await assert.rejects(call("gmail_update_imap", { max_folder_size: 7 }), /max_folder_size/);
});

test("gmail_update_pop and gmail_update_language shape requests", async () => {
  const { calls, call } = gmailSetup();
  await call("gmail_update_pop", { access_window: "allMail" });
  assert.deepEqual(calls[1].req, { userId: "me", requestBody: { accessWindow: "allMail", disposition: "leaveInInbox" } });
  await assert.rejects(call("gmail_update_pop", { disposition: "burn" }), /disposition must be/);
  await call("gmail_update_language", { display_language: " fr " });
  assert.deepEqual(calls.at(-1)!.req, { userId: "me", requestBody: { displayLanguage: "fr" } });
  await assert.rejects(call("gmail_update_language", { display_language: "" }), /display_language is required/);
});

test("gmail_create_filter can forward to a verified address", async () => {
  const { calls, call } = gmailSetup();
  await call("gmail_create_filter", { from: "a@b.c", forward: " fwd@y.z " });
  assert.deepEqual(calls[0].req, { userId: "me", requestBody: { criteria: { from: "a@b.c" }, action: { forward: "fwd@y.z" } } });
  await assert.rejects(call("gmail_create_filter", { from: "a@b.c" }), /at least one action/);
});

// ---------- Directory ----------
function contactsSetup(scopes: string[] | undefined = [`${A}directory.readonly`]) {
  const calls: Call[] = [];
  const rec = recorder(calls);
  const person = { names: [{ displayName: "Ada" }], emailAddresses: [{ value: "ada@corp.com" }] };
  const client: any = {
    people: {
      searchDirectoryPeople: rec("dir.search", { people: [person], nextPageToken: "N", totalSize: 1 }),
      listDirectoryPeople: rec("dir.list", { people: [person] }),
    },
  };
  const tools = createContactsTools(() => client, () => ["me"], () => scopes);
  const call = async (name: string, args: any) => {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `missing ${name}`);
    return json(await t.handler({ account: "me", ...args }));
  };
  return { calls, tools, call };
}

test("directory tools: readOnly, Workspace-only wording, request shape", async () => {
  const { calls, tools, call } = contactsSetup();
  for (const n of ["contacts_search_directory", "contacts_list_directory"]) {
    const t = tools.find((x) => x.name === n)!;
    assert.equal(t.readOnly, true);
    assert.match(t.description, /Workspace/);
  }
  const found = await call("contacts_search_directory", { query: "ad" });
  assert.equal(calls[0].req.query, "ad");
  assert.equal(calls[0].req.readMask, "names,emailAddresses,phoneNumbers");
  assert.deepEqual(calls[0].req.sources, ["DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE", "DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT"]);
  assert.equal(found.people[0].emails[0], "ada@corp.com");
  assert.equal(found.next_page_token, "N");
  await call("contacts_list_directory", { page_size: 3, page_token: "T" });
  assert.equal(calls[1].req.pageSize, 3);
  assert.equal(calls[1].req.pageToken, "T");
  await assert.rejects(call("contacts_search_directory", { query: " " }), /query is required/);
});

test("directory tools refuse a token without directory.readonly; scope is requested", async () => {
  await assert.rejects(contactsSetup([`${A}contacts`]).call("contacts_list_directory", {}), ScopeError);
  assert.ok(SCOPES.includes(`${A}directory.readonly`));
  assert.ok(READ_ONLY_SCOPES.includes(`${A}directory.readonly`));
});

test("every new scope is requested at consent", () => {
  for (const s of ["chat.delete", "chat.users.readstate", "chat.users.spacesettings", "meetings.space.readonly", "directory.readonly"]) {
    assert.ok(SCOPES.includes(`${A}${s}`), s);
  }
});
