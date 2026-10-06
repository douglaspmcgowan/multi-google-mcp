import { getAuthenticatedClient } from "../auth.js";
import { getAccountNames } from "../config.js";
import type { ToolDef } from "./types.js";

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
      },
      required: ["account"],
    },
    handler: async (args: {
      account: string;
      max_results?: number;
      time_min?: string;
      time_max?: string;
      calendar_id?: string;
    }) => {
      const cal = await getCalendar(args.account);
      const res = await cal.events.list({
        calendarId: args.calendar_id || "primary",
        timeMin: args.time_min || new Date().toISOString(),
        timeMax: args.time_max,
        maxResults: args.max_results || 10,
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
    description: `Create a calendar event in a specific Google account. ${accountDescription()}`,
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
      },
      required: ["account", "summary", "start", "end"],
    },
    handler: async (args: {
      account: string;
      summary: string;
      start: string;
      end: string;
      description?: string;
      location?: string;
      attendees?: string[];
      calendar_id?: string;
    }) => {
      const cal = await getCalendar(args.account);
      const res = await cal.events.insert({
        calendarId: args.calendar_id || "primary",
        requestBody: {
          summary: args.summary,
          description: args.description,
          location: args.location,
          start: { dateTime: args.start },
          end: { dateTime: args.end },
          attendees: args.attendees?.map((email) => ({ email })),
        },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Event created: "${res.data.summary}" (${res.data.htmlLink})`,
          },
        ],
      };
    },
  },
  {
    name: "calendar_update_event",
    readOnly: false,
    description: `Update an existing calendar event. ${accountDescription()}`,
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
      },
      required: ["account", "event_id"],
    },
    handler: async (args: {
      account: string;
      event_id: string;
      send_updates?: SendUpdates;
      summary?: string;
      start?: string;
      end?: string;
      description?: string;
      location?: string;
      calendar_id?: string;
    }) => {
      const cal = await getCalendar(args.account);
      const body: Record<string, any> = {};
      if (args.summary) body.summary = args.summary;
      if (args.description) body.description = args.description;
      if (args.location) body.location = args.location;
      if (args.start) body.start = { dateTime: args.start };
      if (args.end) body.end = { dateTime: args.end };

      const res = await cal.events.patch({
        calendarId: args.calendar_id || "primary",
        eventId: args.event_id,
        sendUpdates: args.send_updates || "none",
        requestBody: body,
      });

      return {
        content: [{ type: "text" as const, text: `Event updated: "${res.data.summary}"` }],
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
