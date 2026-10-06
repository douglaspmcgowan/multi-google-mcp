import assert from "node:assert/strict";
import test from "node:test";
import { rsvpToEvent, calendarTools, queryFreeBusy, computeFreeWindows } from "../src/tools/calendar.js";

function fakeCal(attendees: any[] | undefined) {
  const calls: { patch?: any } = {};
  const cal = {
    events: {
      get: async () => ({ data: { summary: "Standup", attendees } }),
      patch: async (req: any) => {
        calls.patch = req;
        return { data: { summary: "Standup", attendees: req.requestBody.attendees } };
      },
    },
  };
  return { cal, calls };
}

test("rsvp changes only the self attendee and defaults sendUpdates to none", async () => {
  const { cal, calls } = fakeCal([
    { email: "a@x.com", responseStatus: "needsAction" },
    { email: "me@x.com", self: true, responseStatus: "needsAction", displayName: "Me" },
    { email: "b@x.com", responseStatus: "accepted" },
  ]);
  const out = await rsvpToEvent(cal, { event_id: "e1", response: "accepted" });
  assert.equal(calls.patch.sendUpdates, "none");
  assert.equal(calls.patch.calendarId, "primary");
  assert.deepEqual(calls.patch.requestBody.attendees, [
    { email: "a@x.com", responseStatus: "needsAction" },
    { email: "me@x.com", self: true, responseStatus: "accepted", displayName: "Me" },
    { email: "b@x.com", responseStatus: "accepted" },
  ]);
  assert.equal(out.responseStatus, "accepted");
  assert.equal(out.summary, "Standup");
});

test("rsvp passes an explicit send_updates and calendar_id", async () => {
  const { cal, calls } = fakeCal([{ email: "me@x.com", self: true }]);
  await rsvpToEvent(cal, { event_id: "e1", response: "tentative", send_updates: "all", calendar_id: "c2" });
  assert.equal(calls.patch.sendUpdates, "all");
  assert.equal(calls.patch.calendarId, "c2");
});

test("rsvp refuses when no attendee is self, without patching", async () => {
  const { cal, calls } = fakeCal([{ email: "a@x.com" }]);
  await assert.rejects(() => rsvpToEvent(cal, { event_id: "e1", response: "declined" }), /not an attendee/);
  assert.equal(calls.patch, undefined);
  const none = fakeCal(undefined);
  await assert.rejects(() => rsvpToEvent(none.cal, { event_id: "e1", response: "declined" }), /not an attendee/);
});

test("calendar_rsvp is registered with the expected arguments", () => {
  const t = calendarTools.find((x) => x.name === "calendar_rsvp");
  assert.ok(t);
  assert.deepEqual((t.inputSchema as any).required, ["account", "event_id", "response"]);
  assert.ok("send_updates" in (t.inputSchema as any).properties);
  const upd = calendarTools.find((x) => x.name === "calendar_update_event")!;
  assert.ok("send_updates" in (upd.inputSchema as any).properties);
});

function fbCal(busy: Array<[string, string]> | Error, requests: any[] = []) {
  return {
    freebusy: {
      query: async (req: any) => {
        requests.push(req);
        if (busy instanceof Error) throw busy;
        const id = req.requestBody.items[0].id;
        return { data: { calendars: { [id]: { busy: busy.map(([start, end]) => ({ start, end })) } } } };
      },
    },
  };
}

test("queryFreeBusy merges busy time across two accounts into shared free windows", async () => {
  const requests: any[] = [];
  const cals: Record<string, any> = {
    a: fbCal([["2026-10-06T10:30:00Z", "2026-10-06T11:30:00Z"]], requests),
    b: fbCal([["2026-10-06T11:00:00Z", "2026-10-06T12:00:00Z"], ["2026-10-06T13:30:00Z", "2026-10-06T14:00:00Z"]]),
  };
  const base = { time_min: "2026-10-06T10:00:00Z", time_max: "2026-10-06T14:00:00Z" };
  const out = await queryFreeBusy((a) => cals[a], ["a", "b"], base);
  assert.deepEqual(out.free_windows, [
    { start: "2026-10-06T10:00:00.000Z", end: "2026-10-06T10:30:00.000Z", minutes: 30 },
    { start: "2026-10-06T12:00:00.000Z", end: "2026-10-06T13:30:00.000Z", minutes: 90 },
  ]);
  assert.equal(out.accounts.a.busy!.length, 1);
  assert.deepEqual(requests[0].requestBody.items, [{ id: "primary" }]);
  const long = await queryFreeBusy((a) => cals[a], ["a", "b"], { ...base, min_minutes: 60 });
  assert.equal(long.free_windows.length, 1);
});

test("queryFreeBusy reports a failing account without failing the rest", async () => {
  const cals: Record<string, any> = {
    a: fbCal([]),
    bad: fbCal(new Error("boom")),
  };
  const out = await queryFreeBusy((a) => cals[a], ["a", "bad"], {
    time_min: "2026-10-06T10:00:00Z",
    time_max: "2026-10-06T11:00:00Z",
  });
  assert.match(out.accounts.bad.error!, /boom/);
  assert.equal(out.free_windows[0].minutes, 60);
});

test("computeFreeWindows clips to working hours in the given UTC offset", () => {
  const min = Date.parse("2026-10-06T00:00:00Z");
  const max = Date.parse("2026-10-07T00:00:00Z");
  // 09:00-17:00 at UTC-7 is 16:00-24:00 UTC.
  const out = computeFreeWindows([], min, max, 30, { start: "09:00", end: "17:00", utc_offset_minutes: -420 });
  const iso = out.map((i) => [new Date(i.start).toISOString(), new Date(i.end).toISOString()]);
  assert.deepEqual(iso, [["2026-10-06T16:00:00.000Z", "2026-10-07T00:00:00.000Z"]]);
});
