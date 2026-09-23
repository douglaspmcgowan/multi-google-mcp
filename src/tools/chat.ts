import type { chat_v1 } from "@googleapis/chat";
import { getAuthenticatedClient } from "../auth.js";
import { getAccountNames } from "../config.js";
import { SCOPE, grantedScopes, withScope, type ScopeLookup } from "../scopes.js";

type ChatClient = chat_v1.Chat;

async function getChat(account: string): Promise<ChatClient> {
  const { chat } = await import("@googleapis/chat");
  return chat({ version: "v1", auth: getAuthenticatedClient(account) as never });
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

/** Accepts "spaces/AAA", "AAA", or a chat.google.com room URL. */
export function spaceName(value: string): string {
  const trimmed = value.trim();
  const fromUrl = /\/(?:room|space)\/([A-Za-z0-9_-]+)/.exec(trimmed);
  if (fromUrl) return `spaces/${fromUrl[1]}`;
  return trimmed.startsWith("spaces/") ? trimmed : `spaces/${trimmed}`;
}

export function userName(email: string): string {
  const trimmed = email.trim();
  return trimmed.startsWith("users/") ? trimmed : `users/${trimmed}`;
}

const NEEDS = {
  spaces: [SCOPE.chatSpaces, SCOPE.chatSpacesReadonly],
  messages: [SCOPE.chatMessages, SCOPE.chatMessagesCreate],
  membersRead: [SCOPE.chatMemberships, SCOPE.chatMembershipsReadonly],
  membersWrite: [SCOPE.chatMemberships],
};

/**
 * Google Chat tools, acting as the signed-in user. They need the chat.* scopes
 * (added after the first release, so older tokens refuse with a re-auth
 * command) and a Google Cloud project with the Chat API enabled and its Chat
 * app configured (name, avatar, description), which Google requires even for
 * user-authenticated calls.
 */
export function createChatTools(
  getClient: (account: string) => ChatClient | Promise<ChatClient> = getChat,
  getAccounts: () => string[] = getAccountNames,
  scopes: ScopeLookup = grantedScopes
) {
  const account = { type: "string" as const, description: "Account label" };
  const space = { type: "string" as const, description: "Space name (spaces/AAA...), bare id, or chat.google.com room URL" };

  return [
    {
      name: "chat_list_spaces",
      description:
        "List Google Chat spaces, group chats and DMs the account belongs to: name (spaces/...), " +
        "displayName, spaceType, spaceUri. filter e.g. 'spaceType = \"SPACE\"'. Needs scope " +
        `chat.spaces. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          filter: { type: "string" as const, description: "Optional Chat API filter, e.g. spaceType = \"SPACE\"" },
          max_results: { type: "number" as const, description: "Maximum spaces (default 200)" },
        },
        required: ["account"],
      },
      handler: async (args: { account: string; filter?: string; max_results?: number }) =>
        withScope(args.account, NEEDS.spaces, scopes, async () => {
          const chat = await getClient(args.account);
          const limit = args.max_results ?? 200;
          const out: chat_v1.Schema$Space[] = [];
          let pageToken: string | undefined;
          do {
            const res = await chat.spaces.list({
              pageSize: Math.min(1000, limit),
              pageToken,
              ...(args.filter ? { filter: args.filter } : {}),
            } as never);
            const data = res.data as chat_v1.Schema$ListSpacesResponse;
            out.push(...(data.spaces ?? []));
            pageToken = data.nextPageToken ?? undefined;
          } while (pageToken && out.length < limit);
          return asText(
            out.slice(0, limit).map((s) => ({
              name: s.name,
              displayName: s.displayName,
              spaceType: s.spaceType,
              spaceUri: s.spaceUri,
            }))
          );
        }),
    },
    {
      name: "chat_post_message",
      description:
        "Post a text message to a Google Chat space as the user. Chat formatting applies " +
        "(*bold*, _italic_, `code`, <url|label>). thread_key or thread_name replies in a " +
        "thread (falls back to a new thread if it does not exist). Needs scope chat.messages. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          space,
          text: { type: "string" as const, description: "Message text" },
          thread_key: { type: "string" as const, description: "Optional client thread key to reply in or start" },
          thread_name: { type: "string" as const, description: "Optional existing thread resource name (spaces/X/threads/Y)" },
        },
        required: ["account", "space", "text"],
      },
      handler: async (args: { account: string; space: string; text: string; thread_key?: string; thread_name?: string }) =>
        withScope(args.account, NEEDS.messages, scopes, async () => {
          if (!args.text.trim()) throw new Error("text is empty");
          const chat = await getClient(args.account);
          const requestBody: Record<string, unknown> = { text: args.text };
          const request: Record<string, unknown> = { parent: spaceName(args.space), requestBody };
          if (args.thread_key || args.thread_name) {
            requestBody.thread = args.thread_name ? { name: args.thread_name } : { threadKey: args.thread_key };
            request.messageReplyOption = "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD";
          }
          const res = await chat.spaces.messages.create(request as never);
          const msg = res.data as chat_v1.Schema$Message;
          return asText({ name: msg.name, space: msg.space?.name, thread: msg.thread?.name, createTime: msg.createTime });
        }),
    },
    {
      name: "chat_list_members",
      description:
        "List the members of a Google Chat space: membership name, member (users/... and type), " +
        "role and state. show_invited includes pending invites. Needs scope chat.memberships. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          space,
          show_invited: { type: "boolean" as const, description: "Include invited (not yet joined) members" },
          max_results: { type: "number" as const, description: "Maximum members (default 500)" },
        },
        required: ["account", "space"],
      },
      handler: async (args: { account: string; space: string; show_invited?: boolean; max_results?: number }) =>
        withScope(args.account, NEEDS.membersRead, scopes, async () => {
          const chat = await getClient(args.account);
          const limit = args.max_results ?? 500;
          const out: chat_v1.Schema$Membership[] = [];
          let pageToken: string | undefined;
          do {
            const res = await chat.spaces.members.list({
              parent: spaceName(args.space),
              pageSize: Math.min(1000, limit),
              pageToken,
              ...(args.show_invited ? { showInvited: true } : {}),
            } as never);
            const data = res.data as chat_v1.Schema$ListMembershipsResponse;
            out.push(...(data.memberships ?? []));
            pageToken = data.nextPageToken ?? undefined;
          } while (pageToken && out.length < limit);
          return asText(
            out.slice(0, limit).map((m) => ({
              name: m.name,
              member: m.member ? { name: m.member.name, displayName: m.member.displayName, type: m.member.type } : undefined,
              role: m.role,
              state: m.state,
            }))
          );
        }),
    },
    {
      name: "chat_add_members",
      description:
        "Add people to a Google Chat space by email: email for one, emails for many. Each " +
        "address is added independently and reported as {email, ok, membership | error}. " +
        "Depending on the space, a person is added directly or invited. Needs scope " +
        `chat.memberships. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          space,
          email: { type: "string" as const, description: "One email address" },
          emails: { type: "array" as const, description: "Several email addresses", items: { type: "string" as const } },
        },
        required: ["account", "space"],
      },
      handler: async (args: { account: string; space: string; email?: string; emails?: string[] }) =>
        withScope(args.account, NEEDS.membersWrite, scopes, async () => {
          const list = [...(args.email ? [args.email] : []), ...(args.emails ?? [])].map((e) => e.trim()).filter(Boolean);
          const seen = new Set<string>();
          const unique = list.filter((e) => !seen.has(e.toLowerCase()) && seen.add(e.toLowerCase()));
          if (!unique.length) throw new Error("pass email or emails");
          const chat = await getClient(args.account);
          const parent = spaceName(args.space);
          const results: Array<Record<string, unknown>> = [];
          for (const email of unique) {
            try {
              const res = await chat.spaces.members.create({
                parent,
                requestBody: { member: { name: userName(email), type: "HUMAN" } },
              } as never);
              const m = res.data as chat_v1.Schema$Membership;
              results.push({ email, ok: true, membership: m.name, state: m.state });
            } catch (error) {
              const message = (error as Error)?.message ?? String(error);
              if (/insufficient authentication scopes/i.test(message)) throw error;
              results.push({ email, ok: false, error: message });
            }
          }
          return asText({
            space: parent,
            added: results.filter((r) => r.ok).length,
            failed: results.filter((r) => !r.ok).length,
            results,
          });
        }),
    },
  ];
}

export const chatTools = createChatTools();
