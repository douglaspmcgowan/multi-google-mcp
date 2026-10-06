import type { meet_v2 } from "@googleapis/meet";
import { getAuthenticatedClient } from "../auth.js";
import { getAccountNames } from "../config.js";
import { grantedScopes, withScope, type ScopeLookup } from "../scopes.js";
import type { ToolDef } from "./types.js";

type MeetClient = meet_v2.Meet;

/** Lets the app create meeting spaces and manage the ones it created. It does not read other spaces, conference records or transcripts. */
export const MEET_CREATED_SCOPE = "https://www.googleapis.com/auth/meetings.space.created";

/** Reads conference records, participants, recordings and transcripts of any meeting the user organized or attended. */
export const MEET_READONLY_SCOPE = "https://www.googleapis.com/auth/meetings.space.readonly";

export const ACCESS_TYPES = ["OPEN", "TRUSTED", "RESTRICTED"] as const;
export const ENTRY_POINT_ACCESS = ["ALL", "CREATOR_APP_ONLY"] as const;

async function getMeet(account: string): Promise<MeetClient> {
  const { meet } = await import("@googleapis/meet");
  return meet({ version: "v2", auth: getAuthenticatedClient(account) as never });
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

function asText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** Accepts "spaces/abc", a bare space id, or a meeting code, and returns the "spaces/..." resource name. */
export function spaceName(input: string): string {
  const s = input.trim();
  if (!s) throw new Error("space is required: a space id, a meeting code such as abc-mnop-xyz, or a spaces/... name.");
  return s.startsWith("spaces/") ? s : `spaces/${s}`;
}

function summarize(s: meet_v2.Schema$Space) {
  return {
    name: s.name,
    meeting_uri: s.meetingUri,
    meeting_code: s.meetingCode,
    access_type: s.config?.accessType,
    entry_point_access: s.config?.entryPointAccess,
    active_conference: s.activeConference?.conferenceRecord ?? null,
  };
}

/** Builds the Space config and the update mask from the options given. Pure. */
export function buildSpaceConfig(args: { access_type?: string; entry_point_access?: string }) {
  const config: Record<string, string> = {};
  const mask: string[] = [];
  if (args.access_type !== undefined) {
    if (!(ACCESS_TYPES as readonly string[]).includes(args.access_type)) {
      throw new Error(`Invalid access_type "${args.access_type}". Use ${ACCESS_TYPES.join(", ")}.`);
    }
    config.accessType = args.access_type;
    mask.push("config.accessType");
  }
  if (args.entry_point_access !== undefined) {
    if (!(ENTRY_POINT_ACCESS as readonly string[]).includes(args.entry_point_access)) {
      throw new Error(`Invalid entry_point_access "${args.entry_point_access}". Use ${ENTRY_POINT_ACCESS.join(", ")}.`);
    }
    config.entryPointAccess = args.entry_point_access;
    mask.push("config.entryPointAccess");
  }
  return { config, mask };
}

/** "conferenceRecords/abc" or a bare id. */
export function conferenceName(input: string): string {
  const s = (input ?? "").trim();
  if (!s) throw new Error("conference_record is required: a conferenceRecords/... name or id.");
  return s.startsWith("conferenceRecords/") ? s : `conferenceRecords/${s}`;
}

const SUB = { participant: "participants", transcript: "transcripts" } as const;

/** Child resource under a conference record: accepts the full name, or the id plus the conference. */
export function childName(kind: keyof typeof SUB, value: string, conference?: string): string {
  const v = (value ?? "").trim();
  if (!v) throw new Error(`${kind} is required.`);
  if (v.startsWith("conferenceRecords/")) return v;
  if (!conference) throw new Error(`Pass the full ${kind} name (conferenceRecords/.../${SUB[kind]}/...) or conference_record plus the id.`);
  return `${conferenceName(conference)}/${SUB[kind]}/${v.replace(new RegExp(`^${SUB[kind]}/`), "")}`;
}

function meetRecordTools(
  getClient: (account: string) => MeetClient | Promise<MeetClient>,
  getAccounts: () => string[],
  lookup: ScopeLookup,
  account: { type: "string"; description: string }
): ToolDef[] {
  const NOTE =
    "Needs scope meetings.space.readonly to see every meeting you organized or attended (meetings.space.created alone sees only spaces this app created). ";
  const run = <T>(a: string, fn: () => Promise<T>) => withScope(a, [MEET_READONLY_SCOPE, MEET_CREATED_SCOPE], lookup, fn);
  const conference = { type: "string" as const, description: "Conference record name (conferenceRecords/...) or id from meet_list_conference_records" };
  const paging = {
    page_size: { type: "number" as const, description: "Max results per page" },
    page_token: { type: "string" as const, description: "next_page_token from the previous call" },
  };
  const filter = (d: string) => ({ type: "string" as const, description: d });
  const page = (a: { page_size?: number; page_token?: string; filter?: string }) => ({
    ...(a.page_size ? { pageSize: a.page_size } : {}),
    ...(a.page_token ? { pageToken: a.page_token } : {}),
    ...(a.filter ? { filter: a.filter } : {}),
  });
  const acc = accountDescription(getAccounts);
  const listTool = (
    name: string,
    description: string,
    extra: Record<string, unknown>,
    required: string[],
    parent: (a: any) => string,
    call: (meet: MeetClient, req: any) => Promise<{ data: any }>,
    key: string
  ): ToolDef => ({
    name,
    readOnly: true,
    description: `${description} ${NOTE}${acc}`,
    inputSchema: { type: "object" as const, properties: { account, ...extra, ...paging }, required: ["account", ...required] },
    handler: async (a: any) => {
      const p = parent(a);
      return run(a.account, async () => {
        const meet = await getClient(a.account);
        const res = await call(meet, { parent: p, ...page(a) });
        return asText({ [key]: res.data[key] ?? [], next_page_token: res.data.nextPageToken || null });
      });
    },
  });

  return [
    {
      name: "meet_list_conference_records",
      readOnly: true,
      description: `List Google Meet conference records (past and current meetings), newest first. Optional filter on space.meeting_code, space.name, start_time, end_time, e.g. start_time>="2026-01-01T00:00:00Z". ${NOTE}${acc}`,
      inputSchema: {
        type: "object" as const,
        properties: { account, filter: filter('Meet filter, e.g. space.meeting_code = "abc-mnop-xyz"'), ...paging },
        required: ["account"],
      },
      handler: async (a: any) =>
        run(a.account, async () => {
          const meet = await getClient(a.account);
          const res = await meet.conferenceRecords.list(page(a));
          return asText({ conference_records: res.data.conferenceRecords ?? [], next_page_token: res.data.nextPageToken || null });
        }),
    },
    {
      name: "meet_get_conference_record",
      readOnly: true,
      description: `Get one conference record: start and end time and its space. ${NOTE}${acc}`,
      inputSchema: { type: "object" as const, properties: { account, conference_record: conference }, required: ["account", "conference_record"] },
      handler: async (a: any) => {
        const name = conferenceName(a.conference_record);
        return run(a.account, async () => {
          const meet = await getClient(a.account);
          return asText((await meet.conferenceRecords.get({ name })).data);
        });
      },
    },
    listTool(
      "meet_list_participants",
      "List who joined a conference (signed-in users, anonymous users, phone callers) with first join and last leave times. Optional filter on earliest_start_time / latest_end_time, e.g. latest_end_time IS NULL for people still in the call.",
      { conference_record: conference, filter: filter("Meet filter") },
      ["conference_record"],
      (a) => conferenceName(a.conference_record),
      (m, r) => m.conferenceRecords.participants.list(r),
      "participants"
    ),
    listTool(
      "meet_list_participant_sessions",
      "List each join-and-leave session of one participant in a conference. Optional filter on start_time / end_time.",
      {
        participant: { type: "string" as const, description: "Participant name (conferenceRecords/X/participants/Y) or id" },
        conference_record: { type: "string" as const, description: "Conference record, when participant is a bare id" },
        filter: filter("Meet filter, e.g. end_time IS NULL"),
      },
      ["participant"],
      (a) => childName("participant", a.participant, a.conference_record),
      (m, r) => m.conferenceRecords.participants.participantSessions.list(r),
      "participantSessions"
    ),
    listTool(
      "meet_list_recordings",
      "List the recordings of a conference: state, start/end time and the Drive file id and download link. Read the file itself with the drive_* tools.",
      { conference_record: conference },
      ["conference_record"],
      (a) => conferenceName(a.conference_record),
      (m, r) => m.conferenceRecords.recordings.list(r),
      "recordings"
    ),
    listTool(
      "meet_list_transcripts",
      "List the transcripts of a conference: state, times and the Google Docs document (docsDestination) holding the transcript, readable with docs_read_markdown.",
      { conference_record: conference },
      ["conference_record"],
      (a) => conferenceName(a.conference_record),
      (m, r) => m.conferenceRecords.transcripts.list(r),
      "transcripts"
    ),
    {
      name: "meet_list_transcript_entries",
      readOnly: true,
      description: `Read the full text of a transcript as speaker-attributed entries (participant, time, language, text), in time order. all_pages fetches every page (up to 50 pages of 100). Entries can differ slightly from the transcript Doc. ${NOTE}${acc}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          transcript: { type: "string" as const, description: "Transcript name (conferenceRecords/X/transcripts/Y) or id" },
          conference_record: { type: "string" as const, description: "Conference record, when transcript is a bare id" },
          all_pages: { type: "boolean" as const, description: "Follow next_page_token until done (default false)" },
          ...paging,
        },
        required: ["account", "transcript"],
      },
      handler: async (a: any) => {
        const parent = childName("transcript", a.transcript, a.conference_record);
        return run(a.account, async () => {
          const meet = await getClient(a.account);
          const entries: unknown[] = [];
          let token: string | undefined = a.page_token;
          let next: string | null = null;
          for (let i = 0; i < (a.all_pages ? 50 : 1); i++) {
            const res = await meet.conferenceRecords.transcripts.entries.list({
              parent,
              pageSize: a.all_pages ? 100 : a.page_size,
              ...(token ? { pageToken: token } : {}),
            });
            entries.push(...(res.data.transcriptEntries ?? []));
            next = res.data.nextPageToken || null;
            if (!next || !a.all_pages) break;
            token = next;
          }
          return asText({ entries, next_page_token: next });
        });
      },
    },
  ];
}

export function createMeetTools(
  getClient: (account: string) => MeetClient | Promise<MeetClient> = getMeet,
  getAccounts: () => string[] = getAccountNames,
  lookup: ScopeLookup = grantedScopes
): ToolDef[] {
  const account = { type: "string" as const, description: "Account label" };
  const space = {
    type: "string" as const,
    description: "Space id, meeting code (abc-mnop-xyz) or full 'spaces/...' name. Only spaces this app created are reachable.",
  };
  const accessType = {
    type: "string" as const,
    enum: [...ACCESS_TYPES],
    description: "Who can join without knocking: OPEN (anyone with the link), TRUSTED (the organizer's organization and invitees), RESTRICTED (invitees only)",
  };
  const entryPoint = {
    type: "string" as const,
    enum: [...ENTRY_POINT_ACCESS],
    description: "ALL (default) or CREATOR_APP_ONLY (only this app's entry point can join)",
  };
  const run = <T>(acct: string, fn: () => Promise<T>) => withScope(acct, [MEET_CREATED_SCOPE], lookup, fn);

  return [
    {
      name: "meet_create_space",
      readOnly: false,
      description: `Create a standalone Google Meet meeting space and return its meeting URI and code. To attach a Meet link to a calendar event instead, use calendar_create_event with add_meet. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: { account, access_type: accessType, entry_point_access: entryPoint },
        required: ["account"],
      },
      handler: async (args: { account: string; access_type?: string; entry_point_access?: string }) => {
        const { config } = buildSpaceConfig(args);
        return run(args.account, async () => {
          const meet = await getClient(args.account);
          const res = await meet.spaces.create({
            requestBody: Object.keys(config).length > 0 ? { config } : {},
          });
          return asText(summarize(res.data));
        });
      },
    },
    {
      name: "meet_get_space",
      readOnly: true,
      description: `Get a Meet space this app created: meeting URI, code, access settings and whether a conference is active. ${accountDescription(getAccounts)}`,
      inputSchema: { type: "object" as const, properties: { account, space }, required: ["account", "space"] },
      handler: async (args: { account: string; space: string }) => {
        const name = spaceName(args.space);
        return run(args.account, async () => {
          const meet = await getClient(args.account);
          const res = await meet.spaces.get({ name });
          return asText(summarize(res.data));
        });
      },
    },
    {
      name: "meet_update_space",
      readOnly: false,
      description: `Change the access settings of a Meet space this app created. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: { account, space, access_type: accessType, entry_point_access: entryPoint },
        required: ["account", "space"],
      },
      handler: async (args: { account: string; space: string; access_type?: string; entry_point_access?: string }) => {
        const name = spaceName(args.space);
        const { config, mask } = buildSpaceConfig(args);
        if (mask.length === 0) throw new Error("Nothing to update: give access_type or entry_point_access.");
        return run(args.account, async () => {
          const meet = await getClient(args.account);
          const res = await meet.spaces.patch({ name, updateMask: mask.join(","), requestBody: { config } });
          return asText(summarize(res.data));
        });
      },
    },
    ...meetRecordTools(getClient, getAccounts, lookup, account),
    {
      name: "meet_end_active_conference",
      readOnly: false,
      description: `End the meeting currently in progress in a Meet space this app created, removing every participant. The space and its link stay valid. ${accountDescription(getAccounts)}`,
      inputSchema: { type: "object" as const, properties: { account, space }, required: ["account", "space"] },
      handler: async (args: { account: string; space: string }) => {
        const name = spaceName(args.space);
        return run(args.account, async () => {
          const meet = await getClient(args.account);
          await meet.spaces.endActiveConference({ name, requestBody: {} });
          return { content: [{ type: "text" as const, text: `Ended the active conference in ${name}.` }] };
        });
      },
    },
  ];
}

export const meetTools: ToolDef[] = createMeetTools();
