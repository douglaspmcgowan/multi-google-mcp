import { createReadStream, statSync } from "node:fs";
import { basename, extname } from "node:path";
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

function summarizeSpace(s: chat_v1.Schema$Space) {
  return {
    name: s.name,
    displayName: s.displayName,
    spaceType: s.spaceType,
    description: s.spaceDetails?.description,
    guidelines: s.spaceDetails?.guidelines,
    spaceUri: s.spaceUri,
  };
}

function summarizeMessage(m: chat_v1.Schema$Message) {
  return {
    name: m.name,
    sender: m.sender?.name,
    text: m.text,
    thread: m.thread?.name,
    createTime: m.createTime,
    lastUpdateTime: m.lastUpdateTime,
    attachments: m.attachment?.map((a) => a.contentName),
  };
}

/** "spaces/A/messages/B", or a bare message id plus the space. */
export function messageName(message: string, space?: string): string {
  const trimmed = message.trim();
  if (/^spaces\/[^/]+\/messages\/[^/]+$/.test(trimmed)) return trimmed;
  if (!space) throw new Error("pass the full message name (spaces/X/messages/Y) or space plus message id");
  return `${spaceName(space)}/messages/${trimmed.replace(/^messages\//, "")}`;
}

/** A membership name, or spaces/X/members/<email> (Chat accepts the email as the member alias). */
function membershipName(args: { space?: string; email?: string; membership?: string }): string {
  if (args.membership) return args.membership.trim();
  if (!args.space || !args.email) throw new Error("pass membership, or space plus email");
  return `${spaceName(args.space)}/members/${args.email.trim()}`;
}

const ROLES: Record<string, string> = { manager: "ROLE_ASSISTANT_MANAGER", member: "ROLE_MEMBER" };

function memberResource(email: string) {
  return { member: { name: userName(email), type: "HUMAN" } };
}

function uniqueEmails(args: { email?: string; emails?: string[] }): string[] {
  const list = [...(args.email ? [args.email] : []), ...(args.emails ?? [])].map((e) => e.trim()).filter(Boolean);
  const seen = new Set<string>();
  return list.filter((e) => !seen.has(e.toLowerCase()) && seen.add(e.toLowerCase()));
}

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".pdf": "application/pdf",
  ".txt": "text/plain", ".csv": "text/csv", ".md": "text/markdown", ".json": "application/json",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

// Narrower Chat scopes SCOPE does not list; any one of them authorizes the call.
const CHAT = "https://www.googleapis.com/auth/";
const chatSpacesCreate = `${CHAT}chat.spaces.create`;
const chatMessagesReadonly = `${CHAT}chat.messages.readonly`;
const chatReactions = `${CHAT}chat.messages.reactions`;
const chatReactionsCreate = `${CHAT}chat.messages.reactions.create`;
const chatReactionsReadonly = `${CHAT}chat.messages.reactions.readonly`;
const chatPins = `${CHAT}chat.spaces.pins`;
const chatPinsReadonly = `${CHAT}chat.spaces.pins.readonly`;

const NEEDS = {
  spaces: [SCOPE.chatSpaces, SCOPE.chatSpacesReadonly],
  spacesCreate: [SCOPE.chatSpaces, chatSpacesCreate],
  spacesWrite: [SCOPE.chatSpaces],
  messagesRead: [SCOPE.chatMessages, chatMessagesReadonly],
  messagesWrite: [SCOPE.chatMessages],
  reactionsRead: [SCOPE.chatMessages, chatMessagesReadonly, chatReactions, chatReactionsReadonly],
  reactionsCreate: [SCOPE.chatMessages, chatReactions, chatReactionsCreate],
  reactionsWrite: [SCOPE.chatMessages, chatReactions],
  messages: [SCOPE.chatMessages, SCOPE.chatMessagesCreate],
  membersRead: [SCOPE.chatMemberships, SCOPE.chatMembershipsReadonly],
  membersWrite: [SCOPE.chatMemberships],
  // chat.spaces already authorizes pin create/delete/list, so pins need no new scope.
  pinsRead: [SCOPE.chatSpaces, SCOPE.chatSpacesReadonly, chatPins, chatPinsReadonly],
  pinsWrite: [SCOPE.chatSpaces, chatPins],
  deleteSpace: [SCOPE.chatDelete],
  readStateRead: [SCOPE.chatReadState, SCOPE.chatReadStateReadonly],
  readStateWrite: [SCOPE.chatReadState],
  spaceSettings: [SCOPE.chatSpaceSettings],
};

const NOTIFICATION_SETTINGS = ["ALL", "MAIN_CONVERSATIONS", "FOR_YOU", "OFF"] as const;
const MUTE_SETTINGS = ["UNMUTED", "MUTED"] as const;

/** users/me/spaces/X/<leaf> for the calling user. */
function userSpaceResource(space: string, leaf: string): string {
  return `users/me/${spaceName(space)}/${leaf}`;
}

/** Normalizes spaces/X/messagePins/Y or a bare pin id (needs space). */
export function pinName(pin: string, space?: string): string {
  const trimmed = pin.trim();
  if (/^spaces\/[^/]+\/messagePins\/[^/]+$/.test(trimmed)) return trimmed;
  if (!space) throw new Error("pass the full pin name (spaces/X/messagePins/Y) or space plus pin id");
  return `${spaceName(space)}/messagePins/${trimmed.replace(/^messagePins\//, "")}`;
}

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

      readOnly: true,
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

      readOnly: false,
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

      readOnly: true,
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

      readOnly: false,
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
    {
      name: "chat_create_space",
      readOnly: false,
      description:
        "Create a named Google Chat space (SPACE) as the user, optionally with initial members by " +
        "email (created in one spaces.setup call, up to 20). external_users allows people outside the " +
        "organization. Needs scope chat.spaces. " + accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          display_name: { type: "string" as const, description: "Space name (up to 128 characters)" },
          description: { type: "string" as const, description: "Optional description" },
          guidelines: { type: "string" as const, description: "Optional guidelines or rules" },
          external_users: { type: "boolean" as const, description: "Allow users outside the organization" },
          email: { type: "string" as const, description: "One initial member email" },
          emails: { type: "array" as const, description: "Initial member emails", items: { type: "string" as const } },
        },
        required: ["account", "display_name"],
      },
      handler: async (args: { account: string; display_name: string; description?: string; guidelines?: string; external_users?: boolean; email?: string; emails?: string[] }) =>
        withScope(args.account, NEEDS.spacesCreate, scopes, async () => {
          if (!args.display_name.trim()) throw new Error("display_name is empty");
          const chat = await getClient(args.account);
          const details = {
            ...(args.description ? { description: args.description } : {}),
            ...(args.guidelines ? { guidelines: args.guidelines } : {}),
          };
          const space: Record<string, unknown> = {
            spaceType: "SPACE",
            displayName: args.display_name.trim(),
            ...(Object.keys(details).length ? { spaceDetails: details } : {}),
            ...(args.external_users !== undefined ? { externalUserAllowed: args.external_users } : {}),
          };
          const emails = uniqueEmails(args);
          const res = emails.length
            ? await chat.spaces.setup({ requestBody: { space, memberships: emails.map(memberResource) } } as never)
            : await chat.spaces.create({ requestBody: space } as never);
          return asText(summarizeSpace(res.data as chat_v1.Schema$Space));
        }),
    },
    {
      name: "chat_create_group_chat",
      readOnly: false,
      description:
        "Create an unnamed Google Chat group chat with two or more other people by email (spaces.setup, " +
        "GROUP_CHAT). The caller is added automatically. Needs scope chat.spaces. " + accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          emails: { type: "array" as const, description: "Two or more member emails (not the caller)", items: { type: "string" as const } },
        },
        required: ["account", "emails"],
      },
      handler: async (args: { account: string; emails: string[] }) =>
        withScope(args.account, NEEDS.spacesCreate, scopes, async () => {
          const emails = uniqueEmails({ emails: args.emails });
          if (emails.length < 2) throw new Error("a group chat needs at least two other people; use chat_find_or_create_dm for one");
          const chat = await getClient(args.account);
          const res = await chat.spaces.setup({
            requestBody: { space: { spaceType: "GROUP_CHAT" }, memberships: emails.map(memberResource) },
          } as never);
          return asText(summarizeSpace(res.data as chat_v1.Schema$Space));
        }),
    },
    {
      name: "chat_find_or_create_dm",
      readOnly: false,
      description:
        "Return the direct message space with one person by email, creating it if none exists " +
        "(spaces.findDirectMessage, then spaces.setup DIRECT_MESSAGE on not-found). Needs scope " +
        "chat.spaces. " + accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: { account, email: { type: "string" as const, description: "The other person's email" } },
        required: ["account", "email"],
      },
      handler: async (args: { account: string; email: string }) =>
        withScope(args.account, NEEDS.spacesCreate, scopes, async () => {
          if (!args.email.trim()) throw new Error("email is empty");
          const chat = await getClient(args.account);
          try {
            const found = await chat.spaces.findDirectMessage({ name: userName(args.email) } as never);
            return asText({ created: false, ...summarizeSpace(found.data as chat_v1.Schema$Space) });
          } catch (error) {
            const e = error as { code?: number | string; status?: number; message?: string };
            const notFound = e.code === 404 || e.code === "404" || e.status === 404 || /not found/i.test(e.message ?? "");
            if (!notFound) throw error;
          }
          const res = await chat.spaces.setup({
            requestBody: { space: { spaceType: "DIRECT_MESSAGE" }, memberships: [memberResource(args.email)] },
          } as never);
          return asText({ created: true, ...summarizeSpace(res.data as chat_v1.Schema$Space) });
        }),
    },
    {
      name: "chat_get_space",
      readOnly: true,
      description: "Get one Google Chat space: name, displayName, spaceType, description, guidelines, spaceUri. Needs scope chat.spaces. " + accountDescription(getAccounts),
      inputSchema: { type: "object" as const, properties: { account, space }, required: ["account", "space"] },
      handler: async (args: { account: string; space: string }) =>
        withScope(args.account, NEEDS.spaces, scopes, async () => {
          const chat = await getClient(args.account);
          const res = await chat.spaces.get({ name: spaceName(args.space) } as never);
          return asText(summarizeSpace(res.data as chat_v1.Schema$Space));
        }),
    },
    {
      name: "chat_update_space",
      readOnly: false,
      description:
        "Rename a Google Chat space or change its description or guidelines (spaces.patch with an " +
        "updateMask built from the fields passed). Needs scope chat.spaces. " + accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          space,
          display_name: { type: "string" as const, description: "New name" },
          description: { type: "string" as const, description: "New description (empty string clears it)" },
          guidelines: { type: "string" as const, description: "New guidelines (empty string clears them)" },
        },
        required: ["account", "space"],
      },
      handler: async (args: { account: string; space: string; display_name?: string; description?: string; guidelines?: string }) =>
        withScope(args.account, NEEDS.spacesWrite, scopes, async () => {
          const mask: string[] = [];
          const body: Record<string, unknown> = {};
          const details: Record<string, unknown> = {};
          if (args.display_name !== undefined) {
            if (!args.display_name.trim()) throw new Error("display_name is empty");
            body.displayName = args.display_name.trim();
            mask.push("displayName");
          }
          if (args.description !== undefined) {
            details.description = args.description;
            mask.push("spaceDetails.description");
          }
          if (args.guidelines !== undefined) {
            details.guidelines = args.guidelines;
            mask.push("spaceDetails.guidelines");
          }
          if (!mask.length) throw new Error("pass display_name, description or guidelines");
          if (Object.keys(details).length) body.spaceDetails = details;
          const chat = await getClient(args.account);
          const res = await chat.spaces.patch({ name: spaceName(args.space), updateMask: mask.join(","), requestBody: body } as never);
          return asText(summarizeSpace(res.data as chat_v1.Schema$Space));
        }),
    },
    {
      name: "chat_list_messages",
      readOnly: true,
      description:
        "List messages in a Google Chat space, newest first by default. Filter by after/before (RFC 3339 " +
        "timestamps on createTime) and thread_name. order is asc or desc. Needs scope chat.messages. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          space,
          after: { type: "string" as const, description: "Only messages created after this RFC 3339 time" },
          before: { type: "string" as const, description: "Only messages created before this RFC 3339 time" },
          thread_name: { type: "string" as const, description: "Only messages in this thread (spaces/X/threads/Y)" },
          order: { type: "string" as const, enum: ["asc", "desc"], description: "createTime order (default desc)" },
          show_deleted: { type: "boolean" as const, description: "Include deleted messages" },
          max_results: { type: "number" as const, description: "Maximum messages (default 25)" },
        },
        required: ["account", "space"],
      },
      handler: async (args: { account: string; space: string; after?: string; before?: string; thread_name?: string; order?: "asc" | "desc"; show_deleted?: boolean; max_results?: number }) =>
        withScope(args.account, NEEDS.messagesRead, scopes, async () => {
          const chat = await getClient(args.account);
          const limit = Math.max(1, args.max_results ?? 25);
          const clauses: string[] = [];
          if (args.after) clauses.push(`createTime > "${args.after}"`);
          if (args.before) clauses.push(`createTime < "${args.before}"`);
          if (args.thread_name) clauses.push(`thread.name = ${args.thread_name}`);
          const out: chat_v1.Schema$Message[] = [];
          let pageToken: string | undefined;
          do {
            const res = await chat.spaces.messages.list({
              parent: spaceName(args.space),
              pageSize: Math.min(1000, limit),
              pageToken,
              orderBy: `createTime ${args.order ?? "desc"}`,
              ...(clauses.length ? { filter: clauses.join(" AND ") } : {}),
              ...(args.show_deleted ? { showDeleted: true } : {}),
            } as never);
            const data = res.data as chat_v1.Schema$ListMessagesResponse;
            out.push(...(data.messages ?? []));
            pageToken = data.nextPageToken ?? undefined;
          } while (pageToken && out.length < limit);
          return asText(out.slice(0, limit).map(summarizeMessage));
        }),
    },
    {
      name: "chat_get_message",
      readOnly: true,
      description: "Get one Google Chat message by full name (spaces/X/messages/Y) or space plus message id. Needs scope chat.messages. " + accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: { account, message: { type: "string" as const, description: "Message name or id" }, space: { type: "string" as const, description: "Space, when message is a bare id" } },
        required: ["account", "message"],
      },
      handler: async (args: { account: string; message: string; space?: string }) =>
        withScope(args.account, NEEDS.messagesRead, scopes, async () => {
          const name = messageName(args.message, args.space);
          const chat = await getClient(args.account);
          const res = await chat.spaces.messages.get({ name } as never);
          return asText(summarizeMessage(res.data as chat_v1.Schema$Message));
        }),
    },
    {
      name: "chat_update_message",
      readOnly: false,
      description:
        "Edit the text of a Google Chat message the user sent (messages.patch, updateMask text). Needs " +
        "scope chat.messages. " + accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          message: { type: "string" as const, description: "Message name or id" },
          space: { type: "string" as const, description: "Space, when message is a bare id" },
          text: { type: "string" as const, description: "New message text" },
        },
        required: ["account", "message", "text"],
      },
      handler: async (args: { account: string; message: string; space?: string; text: string }) =>
        withScope(args.account, NEEDS.messagesWrite, scopes, async () => {
          if (!args.text.trim()) throw new Error("text is empty");
          const name = messageName(args.message, args.space);
          const chat = await getClient(args.account);
          const res = await chat.spaces.messages.patch({ name, updateMask: "text", requestBody: { text: args.text } } as never);
          return asText(summarizeMessage(res.data as chat_v1.Schema$Message));
        }),
    },
    {
      name: "chat_delete_message",
      readOnly: false,
      description:
        "DESTRUCTIVE: delete a Google Chat message the user sent (or, as a space manager, another's). " +
        "It cannot be undone. force also deletes the replies in its thread. Needs scope chat.messages. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          message: { type: "string" as const, description: "Message name or id" },
          space: { type: "string" as const, description: "Space, when message is a bare id" },
          force: { type: "boolean" as const, description: "Also delete threaded replies" },
        },
        required: ["account", "message"],
      },
      handler: async (args: { account: string; message: string; space?: string; force?: boolean }) =>
        withScope(args.account, NEEDS.messagesWrite, scopes, async () => {
          const name = messageName(args.message, args.space);
          const chat = await getClient(args.account);
          await chat.spaces.messages.delete({ name, ...(args.force ? { force: true } : {}) } as never);
          return asText({ deleted: name });
        }),
    },
    {
      name: "chat_remove_member",
      readOnly: false,
      description:
        "DESTRUCTIVE: remove a person from a Google Chat space by email or membership name " +
        "(spaces/X/members/Y). They lose access until re-added. Needs scope chat.memberships. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          space,
          email: { type: "string" as const, description: "Member email" },
          membership: { type: "string" as const, description: "Or the full membership name" },
        },
        required: ["account"],
      },
      handler: async (args: { account: string; space?: string; email?: string; membership?: string }) =>
        withScope(args.account, NEEDS.membersWrite, scopes, async () => {
          const name = membershipName(args);
          const chat = await getClient(args.account);
          await chat.spaces.members.delete({ name } as never);
          return asText({ removed: name });
        }),
    },
    {
      name: "chat_update_member_role",
      readOnly: false,
      description:
        "Set a space member's role to manager (ROLE_ASSISTANT_MANAGER) or member (ROLE_MEMBER) by email " +
        "or membership name. Needs scope chat.memberships. " + accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          space,
          email: { type: "string" as const, description: "Member email" },
          membership: { type: "string" as const, description: "Or the full membership name" },
          role: { type: "string" as const, enum: ["manager", "member"], description: "New role" },
        },
        required: ["account", "role"],
      },
      handler: async (args: { account: string; space?: string; email?: string; membership?: string; role: string }) =>
        withScope(args.account, NEEDS.membersWrite, scopes, async () => {
          const role = ROLES[String(args.role).toLowerCase()];
          if (!role) throw new Error('role must be "manager" or "member"');
          const name = membershipName(args);
          const chat = await getClient(args.account);
          const res = await chat.spaces.members.patch({ name, updateMask: "role", requestBody: { role } } as never);
          const m = res.data as chat_v1.Schema$Membership;
          return asText({ name: m.name ?? name, role: m.role ?? role, state: m.state });
        }),
    },
    {
      name: "chat_add_reaction",
      readOnly: false,
      description: "Add an emoji reaction (unicode, e.g. a thumbs-up character) to a Google Chat message as the user. Needs scope chat.messages. " + accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          message: { type: "string" as const, description: "Message name or id" },
          space: { type: "string" as const, description: "Space, when message is a bare id" },
          emoji: { type: "string" as const, description: "Unicode emoji" },
        },
        required: ["account", "message", "emoji"],
      },
      handler: async (args: { account: string; message: string; space?: string; emoji: string }) =>
        withScope(args.account, NEEDS.reactionsCreate, scopes, async () => {
          if (!args.emoji.trim()) throw new Error("emoji is empty");
          const parent = messageName(args.message, args.space);
          const chat = await getClient(args.account);
          const res = await chat.spaces.messages.reactions.create({ parent, requestBody: { emoji: { unicode: args.emoji.trim() } } } as never);
          const r = res.data as chat_v1.Schema$Reaction;
          return asText({ name: r.name, emoji: r.emoji?.unicode });
        }),
    },
    {
      name: "chat_list_reactions",
      readOnly: true,
      description: "List emoji reactions on a Google Chat message: reaction name, emoji, user. Needs scope chat.messages. " + accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          message: { type: "string" as const, description: "Message name or id" },
          space: { type: "string" as const, description: "Space, when message is a bare id" },
          emoji: { type: "string" as const, description: "Only this unicode emoji" },
          max_results: { type: "number" as const, description: "Maximum reactions (default 100)" },
        },
        required: ["account", "message"],
      },
      handler: async (args: { account: string; message: string; space?: string; emoji?: string; max_results?: number }) =>
        withScope(args.account, NEEDS.reactionsRead, scopes, async () => {
          const parent = messageName(args.message, args.space);
          const chat = await getClient(args.account);
          const limit = Math.max(1, args.max_results ?? 100);
          const out: chat_v1.Schema$Reaction[] = [];
          let pageToken: string | undefined;
          do {
            const res = await chat.spaces.messages.reactions.list({
              parent,
              pageSize: Math.min(200, limit),
              pageToken,
              ...(args.emoji ? { filter: `emoji.unicode = "${args.emoji.trim()}"` } : {}),
            } as never);
            const data = res.data as chat_v1.Schema$ListReactionsResponse;
            out.push(...(data.reactions ?? []));
            pageToken = data.nextPageToken ?? undefined;
          } while (pageToken && out.length < limit);
          return asText(out.slice(0, limit).map((r) => ({ name: r.name, emoji: r.emoji?.unicode, user: r.user?.name })));
        }),
    },
    {
      name: "chat_remove_reaction",
      readOnly: false,
      description: "DESTRUCTIVE: remove one of the user's emoji reactions, by full reaction name (spaces/X/messages/Y/reactions/Z, from chat_list_reactions). Needs scope chat.messages. " + accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: { account, reaction: { type: "string" as const, description: "Reaction name" } },
        required: ["account", "reaction"],
      },
      handler: async (args: { account: string; reaction: string }) =>
        withScope(args.account, NEEDS.reactionsWrite, scopes, async () => {
          const name = args.reaction.trim();
          if (!/^spaces\/[^/]+\/messages\/[^/]+\/reactions\/[^/]+$/.test(name)) throw new Error("reaction must be spaces/X/messages/Y/reactions/Z");
          const chat = await getClient(args.account);
          await chat.spaces.messages.reactions.delete({ name } as never);
          return asText({ deleted: name });
        }),
    },
    {
      name: "chat_list_pins",
      readOnly: true,
      description:
        "List the pinned messages in a Google Chat space (pin names and the messages they pin). " +
        "Needs scope chat.spaces or chat.spaces.readonly. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          space,
          page_size: { type: "number" as const, description: "Max pins per page (max 100)" },
          page_token: { type: "string" as const, description: "next_page_token from the previous call" },
        },
        required: ["account", "space"],
      },
      handler: async (args: { account: string; space: string; page_size?: number; page_token?: string }) =>
        withScope(args.account, NEEDS.pinsRead, scopes, async () => {
          const chat = await getClient(args.account);
          const res = await chat.spaces.messagePins.list({
            parent: spaceName(args.space),
            ...(args.page_size ? { pageSize: args.page_size } : {}),
            ...(args.page_token ? { pageToken: args.page_token } : {}),
          } as never);
          const data = res.data as chat_v1.Schema$ListMessagePinsResponse;
          return asText({ pins: data.messagePins ?? [], next_page_token: data.nextPageToken || null });
        }),
    },
    {
      name: "chat_pin_message",
      readOnly: false,
      description:
        "Pin a message in a Google Chat space so everyone sees it highlighted. Needs scope chat.spaces. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          message: { type: "string" as const, description: "Message name (spaces/X/messages/Y) or id" },
          space: { type: "string" as const, description: "Space, when message is a bare id" },
        },
        required: ["account", "message"],
      },
      handler: async (args: { account: string; message: string; space?: string }) =>
        withScope(args.account, NEEDS.pinsWrite, scopes, async () => {
          const message = messageName(args.message, args.space);
          const parent = message.replace(/\/messages\/[^/]+$/, "");
          const chat = await getClient(args.account);
          const res = await chat.spaces.messagePins.create({ parent, requestBody: { message } } as never);
          return asText(res.data);
        }),
    },
    {
      name: "chat_unpin_message",
      readOnly: false,
      description:
        "Unpin a pinned message in a Google Chat space. Pass the pin name from chat_list_pins " +
        "(spaces/X/messagePins/Y) or a message name, whose id equals its pin id. Needs scope chat.spaces. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          pin: { type: "string" as const, description: "Pin name (spaces/X/messagePins/Y) or pin id" },
          message: { type: "string" as const, description: "Alternatively the pinned message name or id" },
          space: { type: "string" as const, description: "Space, when pin or message is a bare id" },
        },
        required: ["account"],
      },
      handler: async (args: { account: string; pin?: string; message?: string; space?: string }) =>
        withScope(args.account, NEEDS.pinsWrite, scopes, async () => {
          let name: string;
          if (args.pin) name = pinName(args.pin, args.space);
          else if (args.message) name = messageName(args.message, args.space).replace("/messages/", "/messagePins/");
          else throw new Error("pass pin, or message");
          const chat = await getClient(args.account);
          await chat.spaces.messagePins.delete({ name } as never);
          return asText({ unpinned: name });
        }),
    },
    {
      name: "chat_delete_space",
      readOnly: false,
      description:
        "DESTRUCTIVE AND PERMANENT: delete a Google Chat space and all its messages and memberships. " +
        "It cannot be undone and there is no trash. The caller must be allowed to delete the space (its owner/manager). " +
        "Needs scope chat.delete, which Google classifies as restricted. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: { account, space },
        required: ["account", "space"],
      },
      handler: async (args: { account: string; space: string }) =>
        withScope(args.account, NEEDS.deleteSpace, scopes, async () => {
          const name = spaceName(args.space);
          const chat = await getClient(args.account);
          await chat.spaces.delete({ name } as never);
          return asText({ deleted: name });
        }),
    },
    {
      name: "chat_get_read_state",
      readOnly: true,
      description:
        "Get the signed-in user's read state for a space (lastReadTime: messages after it show as unread). " +
        "With thread, returns that thread's read state instead. Only the caller's own state is available. " +
        "Needs scope chat.users.readstate. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          space,
          thread: { type: "string" as const, description: "Optional thread id or name (spaces/X/threads/Y)" },
        },
        required: ["account", "space"],
      },
      handler: async (args: { account: string; space: string; thread?: string }) =>
        withScope(args.account, NEEDS.readStateRead, scopes, async () => {
          const chat = await getClient(args.account);
          if (args.thread) {
            const t = args.thread.trim().replace(/^spaces\/[^/]+\/threads\//, "");
            const name = `${userSpaceResource(args.space, "threads")}/${t}/threadReadState`;
            const res = await chat.users.spaces.threads.getThreadReadState({ name } as never);
            return asText(res.data);
          }
          const res = await chat.users.spaces.getSpaceReadState({ name: userSpaceResource(args.space, "spaceReadState") } as never);
          return asText(res.data);
        }),
    },
    {
      name: "chat_mark_space_read",
      readOnly: false,
      description:
        "Set the signed-in user's last-read time for a space. Default is now, which marks the whole space read. " +
        "Pass an earlier RFC 3339 read_time to mark it (partly) unread. Only top-level messages are affected, not thread replies. " +
        "Needs scope chat.users.readstate. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          space,
          read_time: { type: "string" as const, description: "RFC 3339 timestamp (default: now). Earlier than the latest message leaves the space unread." },
        },
        required: ["account", "space"],
      },
      handler: async (args: { account: string; space: string; read_time?: string }) =>
        withScope(args.account, NEEDS.readStateWrite, scopes, async () => {
          const when = args.read_time ? new Date(args.read_time) : new Date();
          if (Number.isNaN(when.getTime())) throw new Error("read_time is not a valid timestamp");
          const chat = await getClient(args.account);
          const res = await chat.users.spaces.updateSpaceReadState({
            name: userSpaceResource(args.space, "spaceReadState"),
            updateMask: "lastReadTime",
            requestBody: { lastReadTime: when.toISOString() },
          } as never);
          return asText(res.data);
        }),
    },
    {
      name: "chat_get_notification_setting",
      readOnly: true,
      description:
        "Get the signed-in user's notification and mute settings for a Google Chat space. " +
        "Needs scope chat.users.spacesettings. " +
        accountDescription(getAccounts),
      inputSchema: { type: "object" as const, properties: { account, space }, required: ["account", "space"] },
      handler: async (args: { account: string; space: string }) =>
        withScope(args.account, NEEDS.spaceSettings, scopes, async () => {
          const chat = await getClient(args.account);
          const res = await chat.users.spaces.spaceNotificationSetting.get({
            name: userSpaceResource(args.space, "spaceNotificationSetting"),
          } as never);
          return asText(res.data);
        }),
    },
    {
      name: "chat_set_notification_setting",
      readOnly: false,
      description:
        "Change the signed-in user's notifications for a space: notification_setting ALL, MAIN_CONVERSATIONS, FOR_YOU or OFF " +
        "(MAIN_CONVERSATIONS and FOR_YOU are unavailable in 1:1 DMs) and/or mute_setting MUTED or UNMUTED. " +
        "Only the fields you pass change. Needs scope chat.users.spacesettings. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          space,
          notification_setting: { type: "string" as const, enum: [...NOTIFICATION_SETTINGS] },
          mute_setting: { type: "string" as const, enum: [...MUTE_SETTINGS] },
        },
        required: ["account", "space"],
      },
      handler: async (args: { account: string; space: string; notification_setting?: string; mute_setting?: string }) =>
        withScope(args.account, NEEDS.spaceSettings, scopes, async () => {
          const body: Record<string, string> = {};
          const mask: string[] = [];
          if (args.notification_setting !== undefined) {
            if (!(NOTIFICATION_SETTINGS as readonly string[]).includes(args.notification_setting)) {
              throw new Error(`notification_setting must be one of ${NOTIFICATION_SETTINGS.join(", ")}`);
            }
            body.notificationSetting = args.notification_setting;
            mask.push("notification_setting");
          }
          if (args.mute_setting !== undefined) {
            if (!(MUTE_SETTINGS as readonly string[]).includes(args.mute_setting)) {
              throw new Error(`mute_setting must be one of ${MUTE_SETTINGS.join(", ")}`);
            }
            body.muteSetting = args.mute_setting;
            mask.push("mute_setting");
          }
          if (mask.length === 0) throw new Error("pass notification_setting and/or mute_setting");
          const chat = await getClient(args.account);
          const res = await chat.users.spaces.spaceNotificationSetting.patch({
            name: userSpaceResource(args.space, "spaceNotificationSetting"),
            updateMask: mask.join(","),
            requestBody: body,
          } as never);
          return asText(res.data);
        }),
    },
    {
      name: "chat_search_messages",
      readOnly: true,
      description:
        "Search Google Chat messages across every DM and space the user belongs to, or narrow with filter terms. " +
        "query is the Chat search filter: keywords plus fields such as sender.name = \"users/a@b.c\", " +
        "space.name = \"spaces/AAA\", create_time >= \"2026-01-01T00:00:00Z\", attachment:*, has_link(), is_unread() " +
        "(AND between fields, max 1000 chars). Excludes private messages, app messages, blocked users and muted spaces. " +
        "Needs scope chat.messages (or chat.messages.readonly); is_unread() also needs chat.users.readstate. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          query: { type: "string" as const, description: "Chat search filter" },
          page_size: { type: "number" as const, description: "Default 25, max 100" },
          page_token: { type: "string" as const },
          order_by: { type: "string" as const, description: "'create_time desc' (default)" },
        },
        required: ["account", "query"],
      },
      handler: async (args: { account: string; query: string; page_size?: number; page_token?: string; order_by?: string }) =>
        withScope(args.account, NEEDS.messagesRead, scopes, async () => {
          if (!args.query.trim()) throw new Error("query is empty");
          const chat = await getClient(args.account);
          const res = await chat.spaces.messages.search({
            parent: "spaces/-",
            requestBody: {
              filter: args.query,
              ...(args.page_size ? { pageSize: args.page_size } : {}),
              ...(args.page_token ? { pageToken: args.page_token } : {}),
              ...(args.order_by ? { orderBy: args.order_by } : {}),
            },
          } as never);
          const data = res.data as chat_v1.Schema$SearchMessagesResponse;
          return asText({
            results: (data.results ?? []).map((r) => summarizeMessage((r.message ?? {}) as chat_v1.Schema$Message)),
            next_page_token: data.nextPageToken || null,
          });
        }),
    },
    {
      name: "chat_upload_attachment",
      readOnly: false,
      description:
        "Upload a local file (up to 200 MB) and post it as an attachment in a Google Chat space, with " +
        "optional message text and thread reply. Reads the file from disk. Needs scope chat.messages. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          space,
          file_path: { type: "string" as const, description: "Local path of the file to upload" },
          text: { type: "string" as const, description: "Optional message text" },
          mime_type: { type: "string" as const, description: "Optional MIME type (guessed from the extension otherwise)" },
          thread_key: { type: "string" as const, description: "Optional client thread key to reply in or start" },
          thread_name: { type: "string" as const, description: "Optional existing thread name (spaces/X/threads/Y)" },
        },
        required: ["account", "space", "file_path"],
      },
      handler: async (args: { account: string; space: string; file_path: string; text?: string; mime_type?: string; thread_key?: string; thread_name?: string }) =>
        withScope(args.account, NEEDS.messagesWrite, scopes, async () => {
          const size = statSync(args.file_path).size;
          if (size > 200 * 1024 * 1024) throw new Error("file exceeds Chat's 200 MB limit");
          const chat = await getClient(args.account);
          const parent = spaceName(args.space);
          const filename = basename(args.file_path);
          const mimeType = args.mime_type ?? MIME[extname(filename).toLowerCase()] ?? "application/octet-stream";
          const up = await chat.media.upload({
            parent,
            requestBody: { filename },
            media: { mimeType, body: createReadStream(args.file_path) },
          } as never);
          const token = (up.data as chat_v1.Schema$UploadAttachmentResponse).attachmentDataRef?.attachmentUploadToken;
          if (!token) throw new Error("upload returned no attachment token");
          const requestBody: Record<string, unknown> = {
            ...(args.text ? { text: args.text } : {}),
            attachment: [{ attachmentDataRef: { attachmentUploadToken: token }, contentName: filename }],
          };
          const request: Record<string, unknown> = { parent, requestBody };
          if (args.thread_key || args.thread_name) {
            requestBody.thread = args.thread_name ? { name: args.thread_name } : { threadKey: args.thread_key };
            request.messageReplyOption = "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD";
          }
          const res = await chat.spaces.messages.create(request as never);
          return asText({ ...summarizeMessage(res.data as chat_v1.Schema$Message), uploaded: filename, bytes: size });
        }),
    },
  ];
}

export const chatTools = createChatTools();
