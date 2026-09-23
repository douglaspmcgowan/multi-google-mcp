import type { drive_v3 } from "@googleapis/drive";
import { getAuthenticatedClient } from "../auth.js";
import { getAccountNames } from "../config.js";

type DriveClient = drive_v3.Drive;

async function getDrive(account: string): Promise<DriveClient> {
  const { drive } = await import("@googleapis/drive");
  return drive({ version: "v3", auth: getAuthenticatedClient(account) as never });
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

/** The comments resource rejects any call without an explicit `fields` mask. */
export const REPLY_FIELDS = "id,content,author(displayName,emailAddress),createdTime,action";
export const COMMENT_FIELDS =
  "id,content,author(displayName,emailAddress),createdTime,modifiedTime,resolved,anchor," +
  `quotedFileContent,replies(${REPLY_FIELDS})`;

/**
 * Comment tools for any Drive file (Docs, Sheets, Slides, PDFs), through the
 * Drive API's comments and replies resources. The drive scope already covers
 * them. Docs, Sheets and Slides render API-created comments as unanchored even
 * when an anchor is given; quoted_text still shows the quoted passage.
 */
export function createCommentTools(
  getClient: (account: string) => DriveClient | Promise<DriveClient> = getDrive,
  getAccounts: () => string[] = getAccountNames
) {
  const account = { type: "string" as const, description: "Account label" };
  const fileId = { type: "string" as const, description: "Drive file ID (a Doc, Sheet, Slides deck or other file)" };
  const commentId = { type: "string" as const, description: "Comment ID from docs_list_comments" };

  return [
    {
      name: "docs_list_comments",
      description:
        "List comments on a Google Doc (or any Drive file) with their replies, author, quoted " +
        "text and resolved state. Open comments only unless include_resolved=true. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          file_id: fileId,
          include_resolved: { type: "boolean" as const, description: "Include resolved comments (default false)" },
          max_results: { type: "number" as const, description: "Maximum comments to return (default 100)" },
        },
        required: ["account", "file_id"],
      },
      handler: async (args: { account: string; file_id: string; include_resolved?: boolean; max_results?: number }) => {
        const drive = await getClient(args.account);
        const limit = args.max_results ?? 100;
        const out: drive_v3.Schema$Comment[] = [];
        let pageToken: string | undefined;
        do {
          const res = await drive.comments.list({
            fileId: args.file_id,
            pageSize: Math.min(100, limit),
            pageToken,
            includeDeleted: false,
            fields: `nextPageToken,comments(${COMMENT_FIELDS})`,
          } as never);
          const data = res.data as drive_v3.Schema$CommentList;
          for (const comment of data.comments ?? []) {
            if (!args.include_resolved && comment.resolved) continue;
            out.push(comment);
          }
          pageToken = data.nextPageToken ?? undefined;
        } while (pageToken && out.length < limit);
        return asText({ fileId: args.file_id, count: Math.min(out.length, limit), comments: out.slice(0, limit) });
      },
    },
    {
      name: "docs_add_comment",
      description:
        "Add a comment to a Google Doc (or any Drive file). Unanchored by default. quoted_text " +
        "attaches the passage being discussed (shown with the comment); anchor passes a raw " +
        "Drive anchor string. Google Docs/Sheets/Slides display API comments as unanchored " +
        `even with an anchor — that is a Google limitation. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          file_id: fileId,
          content: { type: "string" as const, description: "Comment text" },
          quoted_text: { type: "string" as const, description: "Optional passage the comment refers to" },
          anchor: { type: "string" as const, description: "Optional raw Drive anchor JSON string" },
        },
        required: ["account", "file_id", "content"],
      },
      handler: async (args: { account: string; file_id: string; content: string; quoted_text?: string; anchor?: string }) => {
        const drive = await getClient(args.account);
        const requestBody: Record<string, unknown> = { content: args.content };
        if (args.quoted_text) requestBody.quotedFileContent = { mimeType: "text/plain", value: args.quoted_text };
        if (args.anchor) requestBody.anchor = args.anchor;
        const res = await drive.comments.create({
          fileId: args.file_id,
          fields: COMMENT_FIELDS,
          requestBody,
        } as never);
        return asText(res.data);
      },
    },
    {
      name: "docs_reply_comment",
      description: `Reply to a comment on a Google Doc (or any Drive file). ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          file_id: fileId,
          comment_id: commentId,
          content: { type: "string" as const, description: "Reply text" },
        },
        required: ["account", "file_id", "comment_id", "content"],
      },
      handler: async (args: { account: string; file_id: string; comment_id: string; content: string }) => {
        const drive = await getClient(args.account);
        const res = await drive.replies.create({
          fileId: args.file_id,
          commentId: args.comment_id,
          fields: REPLY_FIELDS,
          requestBody: { content: args.content },
        } as never);
        return asText(res.data);
      },
    },
    {
      name: "docs_resolve_comment",
      description:
        "Resolve a comment (posts a reply with action=resolve, optionally with text). " +
        `reopen=true reopens a resolved comment instead. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          file_id: fileId,
          comment_id: commentId,
          content: { type: "string" as const, description: "Optional closing note" },
          reopen: { type: "boolean" as const, description: "Reopen instead of resolve" },
        },
        required: ["account", "file_id", "comment_id"],
      },
      handler: async (args: { account: string; file_id: string; comment_id: string; content?: string; reopen?: boolean }) => {
        const drive = await getClient(args.account);
        const action = args.reopen ? "reopen" : "resolve";
        const requestBody: Record<string, unknown> = { action };
        if (args.content) requestBody.content = args.content;
        const res = await drive.replies.create({
          fileId: args.file_id,
          commentId: args.comment_id,
          fields: REPLY_FIELDS,
          requestBody,
        } as never);
        return asText({ fileId: args.file_id, commentId: args.comment_id, action, reply: res.data });
      },
    },
  ];
}

export const commentTools = createCommentTools();
