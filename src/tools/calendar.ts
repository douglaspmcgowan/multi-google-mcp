import { getAuthenticatedClient } from "../auth.js";
import { getAccountNames } from "../config.js";
import { grantedScopes, withScope, type ScopeLookup } from "../scopes.js";
import type { ToolDef } from "./types.js";

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
export const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";

async function getCalendar(account: string) {
  const { calendar } = await import("@googleapis/calendar");
  const auth = getAuthenticatedClient(account);
  return calendar({ version: "v3", auth: auth as never });
}

function accountDescription() {
  const names = getAccountNames();
  if (names.length === 0) return "No accounts configured.";
  return `Available accounts: ${names.join(", ")}`;
}

export type Visibility = "default" | "public" | "private" | "confidential";

export interface EventOptions {
  summary?: string;
  start?: string;
  end?: string;
  description?: string;
  location?: string;
  attendees?: string[];
  time_zone?: string;
  recurrence?: string[];
  reminders?: { use_default?: boolean; overrides?: Array<{ method?: "email" | "popup"; minutes: number }> };
  color_id?: string;
  visibility?: Visibility;
  transparency?: "opaque" | "transparent";
  add_meet?: boolean;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A bare YYYY-MM-DD becomes an all-day `date`; anything else is a `dateTime`, with an optional time zone. Pure. */
export function toEventTime(value: string, timeZone?: string): Record<string, string> {
  if (DATE_ONLY.test(value)) return { date: value };
  return timeZone ? { dateTime: value, timeZone } : { dateTime: value };
}

/** Builds a Calendar event body from the supported options, leaving unset fields out. Pure. */
export function buildEventBody(args: EventOptions, requestId?: string): Record<string, any> {
  const body: Record<string, any> = {};
  if (args.summary) body.summary = args.summary;
  if (args.description) body.description = args.description;
  if (args.location) body.location = args.location;
  if (args.start) body.start = toEventTime(args.start, args.time_zone);
  if (args.end) body.end = toEventTime(args.end, args.time_zone);
  if (args.attendees) body.attendees = args.attendees.map((email) => ({ email }));
  if (args.recurrence) body.recurrence = args.recurrence;
  if (args.reminders) {
    body.reminders = {
      useDefault: args.reminders.use_default ?? !args.reminders.overrides,
      ...(args.reminders.overrides
        ? { overrides: args.reminders.overrides.map((o) => ({ method: o.method || "popup", minutes: o.minutes })) }
        : {}),
    };
  }
  if (args.color_id) body.colorId = args.color_id;
  if (args.visibility) body.visibility = args.visibility;
  if (args.transparency) body.transparency = args.transparency;
  if (args.add_meet) {
    body.conferenceData = {
      createRequest: {
        requestId: requestId || `meet-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }
  return body;
}

/** Event fields shared by create and update, as JSON-schema properties. */
const eventOptionProperties = {
  time_zone: { type: "string", description: "IANA time zone for start/end when they carry no offset, e.g. 'America/Los_Angeles'" },
  recurrence: {
    type: "array",
    items: { type: "string" },
    description: "RFC 5545 lines, e.g. ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10']",
  },
  reminders: {
    type: "object",
    description: "{ use_default?: boolean, overrides?: [{ method: 'email'|'popup', minutes: number }] }",
  },
  color_id: { type: "string", description: "Event color id '1'-'11' (see calendar_list_colors)" },
  visibility: { type: "string", enum: ["default", "public", "private", "confidential"], description: "Event visibility" },
  transparency: { type: "string", enum: ["opaque", "transparent"], description: "'opaque' shows as busy, 'transparent' as free" },
  add_meet: { type: "boolean", description: "Attach a new Google Meet link to the event" },
};

function meetLink(data: any): string | undefined {
  return data?.hangoutLink || data?.conferenceData?.entryPoints?.find((e: any) => e.entryPointType === "video")?.uri;
}

/** Insert an event through an injected Calendar client (seam for tests). */
export async function insertEvent(cal: any, args: EventOptions & { calendar_id?: string; send_updates?: SendUpdates }) {
  return cal.events.insert({
    calendarId: args.calendar_id || "primary",
    ...(args.add_meet ? { conferenceDataVersion: 1 } : {}),
    ...(args.send_updates ? { sendUpdates: args.send_updates } : {}),
    requestBody: buildEventBody(args),
  });
}

/** Patch an event through an injected Calendar client (seam for tests). */
export async function patchEvent(cal: any, args: EventOptions & { event_id: string; calendar_id?: string; send_updates?: SendUpdates }) {
  return cal.events.patch({
    calendarId: args.calendar_id || "primary",
    eventId: args.event_id,
    sendUpdates: args.send_updates || "none",
    ...(args.add_meet ? { conferenceDataVersion: 1 } : {}),
    requestBody: buildEventBody(args),
  });
}

export type SendUpdates = "none" | "all" | "externalOnly";
export type RsvpResponse = "accepted" | "declined" | "tentative";

/** RSVP as the authenticated account, through an injected Calendar client (seam for tests). */
export async function rsvpToEvent(
  cal: any,
  args: { event_id: string; response: RsvpResponse; calendar_id?: string; send_updates?: SendUpdates }
): Promise<{ summary: string | null | undefined; responseStatus: string | null | undefined }> {
  if (!["accepted", "declined", "tentative"].includes(args.response)) {
    throw new Error(`Invalid response "${args.response}". Use accepted, declined or tentative.`);
  }
  const calendarId = args.calendar_id || "primary";
  const ev = await cal.events.get({ calendarId, eventId: args.event_id });
  const attendees: any[] = ev.data.attendees || [];
  if (!attendees.some((a) => a.self === true)) {
    throw new Error("This account is not an attendee on the event (no attendee marked self), so it cannot RSVP.");
  }
  const updated = attendees.map((a) => (a.self === true ? { ...a, responseStatus: args.response } : a));
  const res = await cal.events.patch({
    calendarId,
    eventId: args.event_id,
    sendUpdates: args.send_updates || "none",
    requestBody: { attendees: updated },
  });
  const me = (res.data.attendees || []).find((a: any) => a.self === true);
  return { summary: res.data.summary ?? ev.data.summary, responseStatus: me?.responseStatus };
}

export interface Interval {
  start: number;
  end: number;
}

export interface WorkingHours {
  /** "HH:MM" local start of the working day. */
  start: string;
  /** "HH:MM" local end of the working day. */
  end: string;
  /** Offset of local time from UTC in minutes (e.g. -420 for PDT). Default 0. */
  utc_offset_minutes?: number;
}

/** Sort and merge overlapping or touching intervals. Pure. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

function parseHm(hm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if (!m) throw new Error(`Invalid time "${hm}". Use HH:MM.`);
  return (Number(m[1]) * 60 + Number(m[2])) * 60_000;
}

/** Free windows inside [timeMin, timeMax] that no busy interval covers, at least minMinutes long, optionally within daily working hours. Pure. */
export function computeFreeWindows(
  busy: Interval[],
  timeMin: number,
  timeMax: number,
  minMinutes = 30,
  workingHours?: WorkingHours
): Interval[] {
  const merged = mergeIntervals(busy);
  let candidates: Interval[] = [];
  let cursor = timeMin;
  for (const b of merged) {
    if (b.start > cursor) candidates.push({ start: cursor, end: Math.min(b.start, timeMax) });
    cursor = Math.max(cursor, b.end);
    if (cursor >= timeMax) break;
  }
  if (cursor < timeMax) candidates.push({ start: cursor, end: timeMax });

  if (workingHours) {
    const offset = (workingHours.utc_offset_minutes ?? 0) * 60_000;
    const startMs = parseHm(workingHours.start);
    const endMs = parseHm(workingHours.end);
    const DAY = 86_400_000;
    const days: Interval[] = [];
    // Local midnight of the first day touching the range, stepping one day at a time.
    for (let d = Math.floor((timeMin + offset) / DAY) * DAY - offset; d < timeMax; d += DAY) {
      days.push({ start: d + startMs, end: d + endMs });
    }
    const clipped: Interval[] = [];
    for (const c of candidates) {
      for (const d of days) {
        const s = Math.max(c.start, d.start);
        const e = Math.min(c.end, d.end);
        if (e > s) clipped.push({ start: s, end: e });
      }
    }
    candidates = clipped;
  }
  return candidates.filter((c) => c.end - c.start >= minMinutes * 60_000);
}

export interface FreeBusyArgs {
  accounts?: string[];
  time_min: string;
  time_max: string;
  calendar_ids?: Record<string, string[]>;
  min_minutes?: number;
  working_hours?: WorkingHours;
}

/** Busy intervals per account plus merged free windows across all accounts, through an injected Calendar client factory. */
export async function queryFreeBusy(
  getCal: (account: string) => any | Promise<any>,
  allAccounts: string[],
  args: FreeBusyArgs
) {
  const accounts = args.accounts && args.accounts.length > 0 ? args.accounts : allAccounts;
  const timeMin = Date.parse(args.time_min);
  const timeMax = Date.parse(args.time_max);
  if (Number.isNaN(timeMin) || Number.isNaN(timeMax) || timeMax <= timeMin) {
    throw new Error("time_min and time_max must be ISO 8601 timestamps with time_max after time_min.");
  }
  const perAccount: Record<string, { busy?: Array<{ start: string; end: string }>; error?: string }> = {};
  const allBusy: Interval[] = [];
  for (const account of accounts) {
    try {
      const cal = await getCal(account);
      const ids = args.calendar_ids?.[account]?.length ? args.calendar_ids[account] : ["primary"];
      const res = await cal.freebusy.query({
        requestBody: { timeMin: args.time_min, timeMax: args.time_max, items: ids.map((id) => ({ id })) },
      });
      const busy: Interval[] = [];
      for (const id of ids) {
        const entry = res.data.calendars?.[id];
        if (entry?.errors?.length) {
          throw new Error(`calendar ${id}: ${entry.errors.map((e: any) => e.reason).join(", ")}`);
        }
        for (const b of entry?.busy || []) busy.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
      }
      const merged = mergeIntervals(busy);
      allBusy.push(...merged);
      perAccount[account] = {
        busy: merged.map((i) => ({ start: new Date(i.start).toISOString(), end: new Date(i.end).toISOString() })),
      };
    } catch (e) {
      perAccount[account] = { error: (e as Error).message };
    }
  }
  const free = computeFreeWindows(allBusy, timeMin, timeMax, args.min_minutes ?? 30, args.working_hours);
  return {
    accounts: perAccount,
    free_windows: free.map((i) => ({
      start: new Date(i.start).toISOString(),
      end: new Date(i.end).toISOString(),
      minutes: Math.round((i.end - i.start) / 60_000),
    })),
  };
}

export const calendarTools: ToolDef[] = [
  {
    name: "calendar_freebusy",
    readOnly: true,
    description: `Find shared free time across accounts. Returns each account's busy intervals and the merged free windows (free on every listed account) of at least min_minutes. One account failing is reported in its own entry. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        accounts: { type: "array", items: { type: "string" }, description: "Account labels (default: every configured account)" },
        time_min: { type: "string", description: "Start of the range (ISO 8601)" },
        time_max: { type: "string", description: "End of the range (ISO 8601)" },
        calendar_ids: {
          type: "object",
          description: "Optional map of account label to an array of calendar IDs (default: primary)",
        },
        min_minutes: { type: "number", description: "Minimum free window length in minutes (default 30)" },
        working_hours: {
          type: "object",
          description: "Optional daily window: { start: 'HH:MM', end: 'HH:MM', utc_offset_minutes: -420 }",
        },
      },
      required: ["time_min", "time_max"],
    },
    handler: async (args: FreeBusyArgs) => {
      const result = await queryFreeBusy(getCalendar, getAccountNames(), args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  },
  {
    name: "calendar_list_events",
    readOnly: true,
    description: `List upcoming events from a Google Calendar account. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account label" },
        max_results: { type: "number", description: "Max events to return (default 10)" },
        time_min: { type: "string", description: "Start time (ISO 8601). Defaults to now." },
        time_max: { type: "string", description: "End time (ISO 8601). Optional." },
        calendar_id: { type: "string", description: "Calendar ID (default: 'primary')" },
        q: { type: "string", description: "Free-text filter on summary, description, location, attendees" },
      },
      required: ["account"],
    },
    handler: async (args: {
      account: string;
      max_results?: number;
      time_min?: string;
      time_max?: string;
      calendar_id?: string;
      q?: string;
    }) => {
      const cal = await getCalendar(args.account);
      const res = await cal.events.list({
        calendarId: args.calendar_id || "primary",
        timeMin: args.time_min || new Date().toISOString(),
        timeMax: args.time_max,
        maxResults: args.max_results || 10,
        ...(args.q ? { q: args.q } : {}),
        singleEvents: true,
        orderBy: "startTime",
      });

      const events = (res.data.items || []).map((e) => ({
        id: e.id,
        summary: e.summary,
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
        location: e.location,
        ...(e.description ? { description: e.description } : {}),
        status: e.status,
        organizer: e.organizer?.email,
        attendees: e.attendees?.map((a) => ({ email: a.email, response: a.responseStatus })),
      }));

      return { content: [{ type: "text" as const, text: JSON.stringify(events, null, 2) }] };
    },
  },
  {
    name: "calendar_create_event",
    readOnly: false,
    description: `Create a calendar event in a specific Google account. start/end accept ISO 8601 date-times, or YYYY-MM-DD for an all-day event (end date is exclusive). Optional: recurrence (RRULE), reminders, color, visibility, and add_meet to attach a Google Meet link. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account label" },
        summary: { type: "string", description: "Event title" },
        start: { type: "string", description: "Start time (ISO 8601, e.g. '2025-01-15T10:00:00-07:00')" },
        end: { type: "string", description: "End time (ISO 8601)" },
        description: { type: "string", description: "Event description" },
        location: { type: "string", description: "Event location" },
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "List of attendee email addresses",
        },
        calendar_id: { type: "string", description: "Calendar ID (default: 'primary')" },
        send_updates: {
          type: "string",
          enum: ["none", "all", "externalOnly"],
          description: "Who is emailed about the new event (default: Google's default)",
        },
        ...eventOptionProperties,
      },
      required: ["account", "summary", "start", "end"],
    },
    handler: async (args: EventOptions & { account: string; summary: string; start: string; end: string; calendar_id?: string; send_updates?: SendUpdates }) => {
      const cal = await getCalendar(args.account);
      const res = await insertEvent(cal, args);
      const link = meetLink(res.data);
      return {
        content: [
          {
            type: "text" as const,
            text: `Event created: "${res.data.summary}" (${res.data.htmlLink})${link ? ` Meet: ${link}` : ""}`,
          },
        ],
      };
    },
  },
  {
    name: "calendar_update_event",
    readOnly: false,
    description: `Update an existing calendar event. Only the fields you pass change; attendees, when given, replaces the whole attendee list. start/end accept ISO 8601 date-times or YYYY-MM-DD for all-day. Also supports recurrence, reminders, color, visibility, and add_meet. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account label" },
        event_id: { type: "string", description: "Event ID to update" },
        summary: { type: "string", description: "New event title" },
        start: { type: "string", description: "New start time (ISO 8601)" },
        end: { type: "string", description: "New end time (ISO 8601)" },
        description: { type: "string", description: "New event description" },
        location: { type: "string", description: "New event location" },
        calendar_id: { type: "string", description: "Calendar ID (default: 'primary')" },
        send_updates: {
          type: "string",
          enum: ["none", "all", "externalOnly"],
          description: "Who is emailed about the change (default: 'none')",
        },
        attendees: { type: "array", items: { type: "string" }, description: "Replacement attendee email list" },
        ...eventOptionProperties,
      },
      required: ["account", "event_id"],
    },
    handler: async (args: EventOptions & { account: string; event_id: string; calendar_id?: string; send_updates?: SendUpdates }) => {
      const cal = await getCalendar(args.account);
      const res = await patchEvent(cal, args);
      const link = meetLink(res.data);
      return {
        content: [{ type: "text" as const, text: `Event updated: "${res.data.summary}"${link ? ` Meet: ${link}` : ""}` }],
      };
    },
  },
  {
    name: "calendar_rsvp",
    readOnly: false,
    description: `Respond to a calendar invite as this account (accepted, declined or tentative). ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account label" },
        event_id: { type: "string", description: "Event ID to respond to" },
        response: { type: "string", enum: ["accepted", "declined", "tentative"], description: "Your response" },
        calendar_id: { type: "string", description: "Calendar ID (default: 'primary')" },
        send_updates: {
          type: "string",
          enum: ["none", "all", "externalOnly"],
          description: "Who is emailed about the response (default: 'none')",
        },
      },
      required: ["account", "event_id", "response"],
    },
    handler: async (args: {
      account: string;
      event_id: string;
      response: RsvpResponse;
      calendar_id?: string;
      send_updates?: SendUpdates;
    }) => {
      const cal = await getCalendar(args.account);
      const { summary, responseStatus } = await rsvpToEvent(cal, args);
      return {
        content: [{ type: "text" as const, text: `RSVP recorded for "${summary}". Response status: ${responseStatus}` }],
      };
    },
  },
  {
    name: "calendar_delete_event",
    readOnly: false,
    description: `Delete a calendar event. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account label" },
        event_id: { type: "string", description: "Event ID to delete" },
        calendar_id: { type: "string", description: "Calendar ID (default: 'primary')" },
      },
      required: ["account", "event_id"],
    },
    handler: async (args: { account: string; event_id: string; calendar_id?: string }) => {
      const cal = await getCalendar(args.account);
      await cal.events.delete({
        calendarId: args.calendar_id || "primary",
        eventId: args.event_id,
      });
      return { content: [{ type: "text" as const, text: "Event deleted." }] };
    },
  },
  {
    name: "calendar_list_calendars",
    readOnly: true,
    description: `List all calendars in a Google account. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account label" },
      },
      required: ["account"],
    },
    handler: async (args: { account: string }) => {
      const cal = await getCalendar(args.account);
      const res = await cal.calendarList.list();
      const calendars = (res.data.items || []).map((c) => ({
        id: c.id,
        summary: c.summary,
        primary: c.primary || false,
        accessRole: c.accessRole,
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify(calendars, null, 2) }] };
    },
  },
];

function asText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function describeEvent(e: any) {
  return {
    id: e.id,
    summary: e.summary,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    location: e.location,
    status: e.status,
    ...(e.description ? { description: e.description } : {}),
    organizer: e.organizer?.email,
    attendees: e.attendees?.map((a: any) => ({ email: a.email, response: a.responseStatus, optional: a.optional, self: a.self })),
    meet_link: meetLink(e),
    recurrence: e.recurrence,
    recurring_event_id: e.recurringEventId,
    html_link: e.htmlLink,
  };
}

export const ACL_ROLES = ["freeBusyReader", "reader", "writer", "owner"] as const;
export const ACL_SCOPE_TYPES = ["user", "group", "domain", "default"] as const;

/** Calendar tools beyond the original set, built over an injected client (seam for tests). */
export function createCalendarExtraTools(
  getClient: (account: string) => any | Promise<any> = getCalendar,
  getAccounts: () => string[] = getAccountNames,
  lookup: ScopeLookup = grantedScopes
): ToolDef[] {
  const accountDesc = () => {
    try {
      const names = getAccounts();
      return names.length === 0 ? "No accounts configured." : `Available accounts: ${names.join(", ")}`;
    } catch {
      return "Account availability could not be determined.";
    }
  };
  const account = { type: "string" as const, description: "Account label" };
  const calendarId = { type: "string" as const, description: "Calendar ID (default: 'primary')" };
  const eventId = { type: "string" as const, description: "Event ID" };
  // Event tools accept either the full or the events-only grant; calendar, ACL and settings tools need the full one.
  const runEvents = <T>(acct: string, fn: () => Promise<T>) => withScope(acct, [CALENDAR_SCOPE, CALENDAR_EVENTS_SCOPE], lookup, fn);
  const runFull = <T>(acct: string, fn: () => Promise<T>) => withScope(acct, [CALENDAR_SCOPE], lookup, fn);

  return [
    {
      name: "calendar_get_event",
      readOnly: true,
      description: `Get one event in full: attendees with response status, Meet link, recurrence, reminders. ${accountDesc()}`,
      inputSchema: { type: "object" as const, properties: { account, event_id: eventId, calendar_id: calendarId }, required: ["account", "event_id"] },
      handler: async (args: { account: string; event_id: string; calendar_id?: string }) =>
        runEvents(args.account, async () => {
          const cal = await getClient(args.account);
          const res = await cal.events.get({ calendarId: args.calendar_id || "primary", eventId: args.event_id });
          return asText({ ...describeEvent(res.data), reminders: res.data.reminders, color_id: res.data.colorId, visibility: res.data.visibility, transparency: res.data.transparency, creator: res.data.creator?.email });
        }),
    },
    {
      name: "calendar_search_events",
      readOnly: true,
      description: `Search events by free text (summary, description, location, attendees) within an optional time window, on one calendar or on every calendar in the account. ${accountDesc()}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          q: { type: "string", description: "Search text" },
          time_min: { type: "string", description: "Window start (ISO 8601)" },
          time_max: { type: "string", description: "Window end (ISO 8601)" },
          calendar_id: calendarId,
          all_calendars: { type: "boolean", description: "Search every calendar in the account (ignores calendar_id)" },
          max_results: { type: "number", description: "Max events per calendar (default 25)" },
        },
        required: ["account", "q"],
      },
      handler: async (args: { account: string; q: string; time_min?: string; time_max?: string; calendar_id?: string; all_calendars?: boolean; max_results?: number }) =>
        runEvents(args.account, async () => {
          const cal = await getClient(args.account);
          let ids: Array<{ id: string; summary?: string }> = [{ id: args.calendar_id || "primary" }];
          if (args.all_calendars) {
            const list = await cal.calendarList.list();
            ids = (list.data.items || []).map((c: any) => ({ id: c.id, summary: c.summary }));
          }
          const out: any[] = [];
          for (const c of ids) {
            const res = await cal.events.list({
              calendarId: c.id,
              q: args.q,
              timeMin: args.time_min,
              timeMax: args.time_max,
              maxResults: args.max_results || 25,
              singleEvents: true,
              orderBy: "startTime",
            });
            for (const e of res.data.items || []) out.push({ calendar_id: c.id, calendar: c.summary, ...describeEvent(e) });
          }
          return asText(out);
        }),
    },
    {
      name: "calendar_list_instances",
      readOnly: true,
      description: `List the individual occurrences of a recurring event. ${accountDesc()}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          event_id: { type: "string", description: "ID of the recurring event (the series)" },
          calendar_id: calendarId,
          time_min: { type: "string", description: "Window start (ISO 8601)" },
          time_max: { type: "string", description: "Window end (ISO 8601)" },
          max_results: { type: "number", description: "Max instances (default 25)" },
        },
        required: ["account", "event_id"],
      },
      handler: async (args: { account: string; event_id: string; calendar_id?: string; time_min?: string; time_max?: string; max_results?: number }) =>
        runEvents(args.account, async () => {
          const cal = await getClient(args.account);
          const res = await cal.events.instances({
            calendarId: args.calendar_id || "primary",
            eventId: args.event_id,
            timeMin: args.time_min,
            timeMax: args.time_max,
            maxResults: args.max_results || 25,
          });
          return asText((res.data.items || []).map(describeEvent));
        }),
    },
    {
      name: "calendar_quick_add",
      readOnly: false,
      description: `Create an event from a natural-language sentence such as 'Lunch with Sam Friday 12pm'. Google parses the text. ${accountDesc()}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          text: { type: "string", description: "Natural-language description of the event" },
          calendar_id: calendarId,
          send_updates: { type: "string", enum: ["none", "all", "externalOnly"], description: "Who is emailed (default 'none')" },
        },
        required: ["account", "text"],
      },
      handler: async (args: { account: string; text: string; calendar_id?: string; send_updates?: SendUpdates }) =>
        runEvents(args.account, async () => {
          const cal = await getClient(args.account);
          const res = await cal.events.quickAdd({ calendarId: args.calendar_id || "primary", text: args.text, sendUpdates: args.send_updates || "none" });
          return asText(describeEvent(res.data));
        }),
    },
    {
      name: "calendar_move_event",
      readOnly: false,
      description: `Move an event to another calendar in the same account, changing its organizer calendar. ${accountDesc()}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          event_id: eventId,
          calendar_id: { type: "string", description: "Source calendar ID (default: 'primary')" },
          destination_calendar_id: { type: "string", description: "Calendar ID to move the event to" },
          send_updates: { type: "string", enum: ["none", "all", "externalOnly"], description: "Who is emailed (default 'none')" },
        },
        required: ["account", "event_id", "destination_calendar_id"],
      },
      handler: async (args: { account: string; event_id: string; calendar_id?: string; destination_calendar_id: string; send_updates?: SendUpdates }) =>
        runEvents(args.account, async () => {
          const cal = await getClient(args.account);
          const res = await cal.events.move({
            calendarId: args.calendar_id || "primary",
            eventId: args.event_id,
            destination: args.destination_calendar_id,
            sendUpdates: args.send_updates || "none",
          });
          return asText(describeEvent(res.data));
        }),
    },
    {
      name: "calendar_create_calendar",
      readOnly: false,
      description: `Create a new secondary calendar. ${accountDesc()}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          summary: { type: "string", description: "Calendar title" },
          description: { type: "string", description: "Calendar description" },
          location: { type: "string", description: "Geographic location" },
          time_zone: { type: "string", description: "IANA time zone, e.g. 'America/Los_Angeles'" },
        },
        required: ["account", "summary"],
      },
      handler: async (args: { account: string; summary: string; description?: string; location?: string; time_zone?: string }) =>
        runFull(args.account, async () => {
          const cal = await getClient(args.account);
          const res = await cal.calendars.insert({
            requestBody: { summary: args.summary, description: args.description, location: args.location, timeZone: args.time_zone },
          });
          return asText({ id: res.data.id, summary: res.data.summary, time_zone: res.data.timeZone });
        }),
    },
    {
      name: "calendar_update_calendar",
      readOnly: false,
      description: `Change a calendar's title, description, location or time zone. Only the fields you pass change. ${accountDesc()}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          calendar_id: { type: "string", description: "Calendar ID to update" },
          summary: { type: "string", description: "New title" },
          description: { type: "string", description: "New description" },
          location: { type: "string", description: "New location" },
          time_zone: { type: "string", description: "New IANA time zone" },
        },
        required: ["account", "calendar_id"],
      },
      handler: async (args: { account: string; calendar_id: string; summary?: string; description?: string; location?: string; time_zone?: string }) =>
        runFull(args.account, async () => {
          const body: Record<string, any> = {};
          if (args.summary !== undefined) body.summary = args.summary;
          if (args.description !== undefined) body.description = args.description;
          if (args.location !== undefined) body.location = args.location;
          if (args.time_zone !== undefined) body.timeZone = args.time_zone;
          if (Object.keys(body).length === 0) throw new Error("Nothing to update: give summary, description, location or time_zone.");
          const cal = await getClient(args.account);
          const res = await cal.calendars.patch({ calendarId: args.calendar_id, requestBody: body });
          return asText({ id: res.data.id, summary: res.data.summary, description: res.data.description, location: res.data.location, time_zone: res.data.timeZone });
        }),
    },
    {
      name: "calendar_delete_calendar",
      readOnly: false,
      description: `DESTRUCTIVE: permanently delete a secondary calendar and every event on it. This cannot be undone. The primary calendar cannot be deleted. ${accountDesc()}`,
      inputSchema: {
        type: "object" as const,
        properties: { account, calendar_id: { type: "string", description: "ID of the secondary calendar to delete" } },
        required: ["account", "calendar_id"],
      },
      handler: async (args: { account: string; calendar_id: string }) => {
        if (args.calendar_id === "primary") throw new Error("The primary calendar cannot be deleted. Pass a secondary calendar's ID.");
        return runFull(args.account, async () => {
          const cal = await getClient(args.account);
          await cal.calendars.delete({ calendarId: args.calendar_id });
          return { content: [{ type: "text" as const, text: `Calendar ${args.calendar_id} and all its events were deleted.` }] };
        });
      },
    },
    {
      name: "calendar_list_acl",
      readOnly: true,
      description: `List who a calendar is shared with and their roles. ${accountDesc()}`,
      inputSchema: { type: "object" as const, properties: { account, calendar_id: calendarId }, required: ["account"] },
      handler: async (args: { account: string; calendar_id?: string }) =>
        runFull(args.account, async () => {
          const cal = await getClient(args.account);
          const res = await cal.acl.list({ calendarId: args.calendar_id || "primary" });
          return asText((res.data.items || []).map((r: any) => ({ id: r.id, role: r.role, scope_type: r.scope?.type, scope_value: r.scope?.value })));
        }),
    },
    {
      name: "calendar_share_calendar",
      readOnly: false,
      description: `Share a calendar by granting a role to a user, group, domain, or everyone (scope_type 'default', which makes it public). Roles: freeBusyReader, reader, writer, owner. ${accountDesc()}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          calendar_id: calendarId,
          scope_type: { type: "string", enum: [...ACL_SCOPE_TYPES], description: "Who the rule applies to (default 'user')" },
          scope_value: { type: "string", description: "Email address or domain; omit for scope_type 'default'" },
          role: { type: "string", enum: [...ACL_ROLES], description: "Access level to grant" },
          send_notifications: { type: "boolean", description: "Email the person about the share (default true)" },
        },
        required: ["account", "role"],
      },
      handler: async (args: { account: string; calendar_id?: string; scope_type?: string; scope_value?: string; role: string; send_notifications?: boolean }) => {
        if (!(ACL_ROLES as readonly string[]).includes(args.role)) throw new Error(`Invalid role "${args.role}". Use ${ACL_ROLES.join(", ")}.`);
        const type = args.scope_type || "user";
        if (!(ACL_SCOPE_TYPES as readonly string[]).includes(type)) throw new Error(`Invalid scope_type "${type}". Use ${ACL_SCOPE_TYPES.join(", ")}.`);
        if (type !== "default" && !args.scope_value) throw new Error(`scope_value is required for scope_type "${type}".`);
        return runFull(args.account, async () => {
          const cal = await getClient(args.account);
          const res = await cal.acl.insert({
            calendarId: args.calendar_id || "primary",
            sendNotifications: args.send_notifications ?? true,
            requestBody: { role: args.role, scope: type === "default" ? { type } : { type, value: args.scope_value } },
          });
          return asText({ id: res.data.id, role: res.data.role, scope_type: res.data.scope?.type, scope_value: res.data.scope?.value });
        });
      },
    },
    {
      name: "calendar_unshare_calendar",
      readOnly: false,
      description: `Remove a sharing rule from a calendar. Get rule_id from calendar_list_acl (e.g. 'user:sam@example.com'). ${accountDesc()}`,
      inputSchema: {
        type: "object" as const,
        properties: { account, calendar_id: calendarId, rule_id: { type: "string", description: "ACL rule ID" } },
        required: ["account", "rule_id"],
      },
      handler: async (args: { account: string; calendar_id?: string; rule_id: string }) =>
        runFull(args.account, async () => {
          const cal = await getClient(args.account);
          await cal.acl.delete({ calendarId: args.calendar_id || "primary", ruleId: args.rule_id });
          return { content: [{ type: "text" as const, text: `Sharing rule ${args.rule_id} removed.` }] };
        }),
    },
    {
      name: "calendar_list_colors",
      readOnly: true,
      description: `List the calendar and event color ids and their hex values. ${accountDesc()}`,
      inputSchema: { type: "object" as const, properties: { account }, required: ["account"] },
      handler: async (args: { account: string }) =>
        runEvents(args.account, async () => {
          const cal = await getClient(args.account);
          const res = await cal.colors.get();
          return asText({ calendar: res.data.calendar, event: res.data.event });
        }),
    },
    {
      name: "calendar_get_settings",
      readOnly: true,
      description: `Get the account's Calendar settings (time zone, week start, default event length and similar). ${accountDesc()}`,
      inputSchema: { type: "object" as const, properties: { account }, required: ["account"] },
      handler: async (args: { account: string }) =>
        runFull(args.account, async () => {
          const cal = await getClient(args.account);
          const res = await cal.settings.list();
          return asText(Object.fromEntries((res.data.items || []).map((s: any) => [s.id, s.value])));
        }),
    },
  ];
}

calendarTools.push(...createCalendarExtraTools());
