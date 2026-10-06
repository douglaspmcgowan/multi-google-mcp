import assert from "node:assert/strict";
import test from "node:test";
import { buildEventBody, toEventTime, calendarTools, createCalendarExtraTools, insertEvent, patchEvent } from "../src/tools/calendar.js";
import { ScopeError } from "../src/scopes.js";

function fake() {
  const calls: Record<string, any> = {};
  const rec = (key: string, data: any) => async (r?: any) => ((calls[key] = r), { data });
  const client: any = {
    events: {
      get: rec("get", { id: "e1", summary: "S", attendees: [{ email: "a@x.com", responseStatus: "accepted" }], hangoutLink: "https://meet.google.com/aaa", recurrence: ["RRULE:FREQ=DAILY"] }),
      list: rec("list", { items: [{ id: "e2", summary: "Found" }] }),
      instances: rec("instances", { items: [{ id: "e1_20261006", recurringEventId: "e1" }] }),
      quickAdd: rec("quickAdd", { id: "e3", summary: "Lunch" }),
      move: rec("move", { id: "e1" }),
    },
    calendarList: { list: rec("calList", { items: [{ id: "c1", summary: "One" }, { id: "c2", summary: "Two" }] }) },
    calendars: {
      insert: rec("calInsert", { id: "c9", summary: "New cal", timeZone: "UTC" }),
      patch: rec("calPatch", { id: "c9", summary: "Renamed" }),
      delete: rec("calDelete", {}),
    },
    acl: {
      list: rec("aclList", { items: [{ id: "user:a@x.com", role: "reader", scope: { type: "user", value: "a@x.com" } }] }),
      insert: rec("aclInsert", { id: "user:b@x.com", role: "writer", scope: { type: "user", value: "b@x.com" } }),
      delete: rec("aclDelete", {}),
    },
    colors: { get: rec("colors", { calendar: { "1": { background: "#fff" } }, event: { "1": { background: "#000" } } }) },
    settings: { list: rec("settings", { items: [{ id: "timezone", value: "America/Los_Angeles" }] }) },
  };
  return { calls, client };
}

function build(lookup: (a: string) => string[] | undefined = () => undefined) {
  const { calls, client } = fake();
  const tools = createCalendarExtraTools(() => client, () => ["me"], lookup);
  const call = async (name: string, args: any) => {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `missing ${name}`);
    return JSON.parse((await t.handler({ account: "me", ...args })).content[0].text);
  };
  return { calls, tools, call };
}

const FULL = "https://www.googleapis.com/auth/calendar";
const EVENTS = "https://www.googleapis.com/auth/calendar.events";

test("event times: bare date is all-day, date-time keeps its zone", () => {
  assert.deepEqual(toEventTime("2026-10-06"), { date: "2026-10-06" });
  assert.deepEqual(toEventTime("2026-10-06T10:00:00", "America/Los_Angeles"), { dateTime: "2026-10-06T10:00:00", timeZone: "America/Los_Angeles" });
  assert.deepEqual(toEventTime("2026-10-06T10:00:00-07:00"), { dateTime: "2026-10-06T10:00:00-07:00" });
});

test("buildEventBody covers recurrence, reminders, colour, visibility, attendees, meet", () => {
  const body = buildEventBody(
    {
      summary: "Weekly",
      start: "2026-10-06",
      end: "2026-10-07",
      location: "Room",
      attendees: ["a@x.com"],
      recurrence: ["RRULE:FREQ=WEEKLY"],
      reminders: { overrides: [{ minutes: 10 }, { method: "email", minutes: 60 }] },
      color_id: "5",
      visibility: "private",
      transparency: "transparent",
      add_meet: true,
    },
    "req-1"
  );
  assert.deepEqual(body.start, { date: "2026-10-06" });
  assert.deepEqual(body.attendees, [{ email: "a@x.com" }]);
  assert.deepEqual(body.recurrence, ["RRULE:FREQ=WEEKLY"]);
  assert.deepEqual(body.reminders, { useDefault: false, overrides: [{ method: "popup", minutes: 10 }, { method: "email", minutes: 60 }] });
  assert.equal(body.colorId, "5");
  assert.equal(body.visibility, "private");
  assert.equal(body.transparency, "transparent");
  assert.deepEqual(body.conferenceData, { createRequest: { requestId: "req-1", conferenceSolutionKey: { type: "hangoutsMeet" } } });
  assert.deepEqual(buildEventBody({ summary: "x" }), { summary: "x" });
  assert.deepEqual(buildEventBody({ reminders: { use_default: true } }).reminders, { useDefault: true });
});

test("create and update event schemas expose the new options", () => {
  const create = calendarTools.find((t) => t.name === "calendar_create_event")!;
  const update = calendarTools.find((t) => t.name === "calendar_update_event")!;
  for (const key of ["add_meet", "recurrence", "reminders", "color_id", "visibility", "time_zone", "transparency"]) {
    assert.ok(key in create.inputSchema.properties, `create lacks ${key}`);
    assert.ok(key in update.inputSchema.properties, `update lacks ${key}`);
  }
  assert.ok("attendees" in update.inputSchema.properties);
  assert.ok("send_updates" in create.inputSchema.properties);
  assert.deepEqual(create.inputSchema.required, ["account", "summary", "start", "end"]);
});

test("insertEvent and patchEvent send conferenceDataVersion only with add_meet", async () => {
  const seen: any[] = [];
  const cal: any = { events: { insert: async (r: any) => (seen.push(r), { data: {} }), patch: async (r: any) => (seen.push(r), { data: {} }) } };
  await insertEvent(cal, { summary: "A", start: "2026-10-06T10:00:00-07:00", end: "2026-10-06T11:00:00-07:00", add_meet: true, send_updates: "all" });
  assert.equal(seen[0].conferenceDataVersion, 1);
  assert.equal(seen[0].sendUpdates, "all");
  assert.equal(seen[0].calendarId, "primary");
  assert.equal(seen[0].requestBody.conferenceData.createRequest.conferenceSolutionKey.type, "hangoutsMeet");
  await insertEvent(cal, { summary: "B", start: "2026-10-06", end: "2026-10-07" });
  assert.equal("conferenceDataVersion" in seen[1], false);
  assert.equal("sendUpdates" in seen[1], false);
  assert.deepEqual(seen[1].requestBody, { summary: "B", start: { date: "2026-10-06" }, end: { date: "2026-10-07" } });
  await patchEvent(cal, { event_id: "e1", recurrence: ["RRULE:FREQ=DAILY"], add_meet: true });
  assert.equal(seen[2].conferenceDataVersion, 1);
  assert.equal(seen[2].sendUpdates, "none");
  assert.equal(seen[2].eventId, "e1");
  assert.deepEqual(seen[2].requestBody.recurrence, ["RRULE:FREQ=DAILY"]);
});

test("list_events accepts q", () => {
  const list = calendarTools.find((t) => t.name === "calendar_list_events")!;
  assert.ok("q" in list.inputSchema.properties);
});

test("get_event returns attendees, meet link and recurrence", async () => {
  const { calls, call } = build();
  const out = await call("calendar_get_event", { event_id: "e1" });
  assert.equal(calls.get.calendarId, "primary");
  assert.equal(calls.get.eventId, "e1");
  assert.equal(out.meet_link, "https://meet.google.com/aaa");
  assert.deepEqual(out.recurrence, ["RRULE:FREQ=DAILY"]);
  assert.equal(out.attendees[0].response, "accepted");
});

test("search_events passes q and window; all_calendars fans out over calendarList", async () => {
  const { calls, call } = build();
  const one = await call("calendar_search_events", { q: "dentist", time_min: "2026-10-01T00:00:00Z", time_max: "2026-11-01T00:00:00Z" });
  assert.equal(calls.list.q, "dentist");
  assert.equal(calls.list.calendarId, "primary");
  assert.equal(calls.list.timeMin, "2026-10-01T00:00:00Z");
  assert.equal(one[0].summary, "Found");
  const all = await call("calendar_search_events", { q: "x", all_calendars: true });
  assert.deepEqual(all.map((e: any) => e.calendar_id), ["c1", "c2"]);
});

test("list_instances, quick_add and move_event shape requests", async () => {
  const { calls, call } = build();
  const inst = await call("calendar_list_instances", { event_id: "e1", max_results: 5 });
  assert.equal(calls.instances.eventId, "e1");
  assert.equal(calls.instances.maxResults, 5);
  assert.equal(inst[0].recurring_event_id, "e1");
  await call("calendar_quick_add", { text: "Lunch Friday noon" });
  assert.deepEqual(calls.quickAdd, { calendarId: "primary", text: "Lunch Friday noon", sendUpdates: "none" });
  await call("calendar_move_event", { event_id: "e1", destination_calendar_id: "c2", calendar_id: "c1", send_updates: "all" });
  assert.deepEqual(calls.move, { calendarId: "c1", eventId: "e1", destination: "c2", sendUpdates: "all" });
});

test("calendar create, update and delete", async () => {
  const { calls, call, tools } = build();
  await call("calendar_create_calendar", { summary: "Trips", time_zone: "UTC" });
  assert.equal(calls.calInsert.requestBody.summary, "Trips");
  assert.equal(calls.calInsert.requestBody.timeZone, "UTC");
  await call("calendar_update_calendar", { calendar_id: "c9", summary: "Renamed" });
  assert.deepEqual(calls.calPatch, { calendarId: "c9", requestBody: { summary: "Renamed" } });
  await assert.rejects(() => call("calendar_update_calendar", { calendar_id: "c9" }), /Nothing to update/);
  const del = tools.find((t) => t.name === "calendar_delete_calendar")!;
  assert.match(del.description, /DESTRUCTIVE/);
  await del.handler({ account: "me", calendar_id: "c9" });
  assert.deepEqual(calls.calDelete, { calendarId: "c9" });
  await assert.rejects(() => del.handler({ account: "me", calendar_id: "primary" }), /primary calendar cannot be deleted/);
});

test("ACL list, share and unshare", async () => {
  const { calls, call, tools } = build();
  const acl = await call("calendar_list_acl", {});
  assert.equal(acl[0].role, "reader");
  await call("calendar_share_calendar", { calendar_id: "c1", scope_value: "b@x.com", role: "writer" });
  assert.deepEqual(calls.aclInsert, { calendarId: "c1", sendNotifications: true, requestBody: { role: "writer", scope: { type: "user", value: "b@x.com" } } });
  await call("calendar_share_calendar", { scope_type: "default", role: "reader", send_notifications: false });
  assert.deepEqual(calls.aclInsert.requestBody.scope, { type: "default" });
  assert.equal(calls.aclInsert.sendNotifications, false);
  await assert.rejects(() => call("calendar_share_calendar", { role: "reader" }), /scope_value is required/);
  await assert.rejects(() => call("calendar_share_calendar", { role: "admin", scope_value: "a@x.com" }), /Invalid role/);
  const unshare = tools.find((t) => t.name === "calendar_unshare_calendar")!;
  await unshare.handler({ account: "me", calendar_id: "c1", rule_id: "user:b@x.com" });
  assert.deepEqual(calls.aclDelete, { calendarId: "c1", ruleId: "user:b@x.com" });
});

test("colors and settings", async () => {
  const { call } = build();
  assert.ok((await call("calendar_list_colors", {})).event["1"]);
  assert.deepEqual(await call("calendar_get_settings", {}), { timezone: "America/Los_Angeles" });
});

test("readOnly flags are right for every new tool", () => {
  const { tools } = build();
  const writes = ["calendar_quick_add", "calendar_move_event", "calendar_create_calendar", "calendar_update_calendar", "calendar_delete_calendar", "calendar_share_calendar", "calendar_unshare_calendar"];
  for (const t of tools) assert.equal(t.readOnly, !writes.includes(t.name), t.name);
  assert.equal(tools.length, 13);
  assert.ok(calendarTools.some((t) => t.name === "calendar_get_event"));
});

test("scope refusal: calendar-level tools need the full scope, event tools accept events-only", async () => {
  const eventsOnly = build(() => [EVENTS]);
  await assert.rejects(() => eventsOnly.call("calendar_list_acl", {}), ScopeError);
  await assert.rejects(() => eventsOnly.call("calendar_create_calendar", { summary: "x" }), ScopeError);
  await assert.rejects(() => eventsOnly.call("calendar_get_settings", {}), ScopeError);
  assert.equal((await eventsOnly.call("calendar_get_event", { event_id: "e1" })).id, "e1");
  const none = build(() => ["https://www.googleapis.com/auth/drive"]);
  await assert.rejects(() => none.call("calendar_get_event", { event_id: "e1" }), ScopeError);
  const full = build(() => [FULL]);
  assert.ok(await full.call("calendar_list_acl", {}));
});
