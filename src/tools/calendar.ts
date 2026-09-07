import { calendar } from "@googleapis/calendar";
import { getAuthenticatedClient } from "../auth.js";
import { getAccountNames } from "../config.js";

function getCalendar(account: string) {
  const auth = getAuthenticatedClient(account);
  return calendar({ version: "v3", auth });
}

function accountDescription() {
  const names = getAccountNames();
  if (names.length === 0) return "No accounts configured.";
  return `Available accounts: ${names.join(", ")}`;
}

export const calendarTools = [
  {
    name: "calendar_list_events",
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
      const cal = getCalendar(args.account);
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
        status: e.status,
        organizer: e.organizer?.email,
        attendees: e.attendees?.map((a) => ({ email: a.email, response: a.responseStatus })),
      }));

      return { content: [{ type: "text" as const, text: JSON.stringify(events, null, 2) }] };
    },
  },
  {
    name: "calendar_create_event",
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
      const cal = getCalendar(args.account);
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
      },
      required: ["account", "event_id"],
    },
    handler: async (args: {
      account: string;
      event_id: string;
      summary?: string;
      start?: string;
      end?: string;
      description?: string;
      location?: string;
      calendar_id?: string;
    }) => {
      const cal = getCalendar(args.account);
      const body: Record<string, any> = {};
      if (args.summary) body.summary = args.summary;
      if (args.description) body.description = args.description;
      if (args.location) body.location = args.location;
      if (args.start) body.start = { dateTime: args.start };
      if (args.end) body.end = { dateTime: args.end };

      const res = await cal.events.patch({
        calendarId: args.calendar_id || "primary",
        eventId: args.event_id,
        requestBody: body,
      });

      return {
        content: [{ type: "text" as const, text: `Event updated: "${res.data.summary}"` }],
      };
    },
  },
  {
    name: "calendar_delete_event",
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
      const cal = getCalendar(args.account);
      await cal.events.delete({
        calendarId: args.calendar_id || "primary",
        eventId: args.event_id,
      });
      return { content: [{ type: "text" as const, text: "Event deleted." }] };
    },
  },
  {
    name: "calendar_list_calendars",
    description: `List all calendars in a Google account. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account label" },
      },
      required: ["account"],
    },
    handler: async (args: { account: string }) => {
      const cal = getCalendar(args.account);
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
