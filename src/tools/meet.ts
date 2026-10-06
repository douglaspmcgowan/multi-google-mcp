import type { meet_v2 } from "@googleapis/meet";
import { getAuthenticatedClient } from "../auth.js";
import { getAccountNames } from "../config.js";
import { grantedScopes, withScope, type ScopeLookup } from "../scopes.js";
import type { ToolDef } from "./types.js";

type MeetClient = meet_v2.Meet;

/** Lets the app create meeting spaces and manage the ones it created. It does not read other spaces, conference records or transcripts. */
export const MEET_CREATED_SCOPE = "https://www.googleapis.com/auth/meetings.space.created";

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
