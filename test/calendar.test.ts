import assert from "node:assert/strict";
import test from "node:test";
import { rsvpToEvent, calendarTools } from "../src/tools/calendar.js";

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
