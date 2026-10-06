import { getAuthenticatedClient } from "../auth.js";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { getAccountNames } from "../config.js";
import type { ToolDef } from "./types.js";
import { SCOPE, grantedScopes, withScope, type ScopeLookup } from "../scopes.js";

async function getGmail(account: string) {
  const { gmail } = await import("@googleapis/gmail");
  const auth = getAuthenticatedClient(account);
  return gmail({ version: "v1", auth: auth as never });
}

function accountDescription() {
  const names = getAccountNames();
  if (names.length === 0) return "No accounts configured.";
  return `Available accounts: ${names.join(", ")}`;
}

/** Decode common HTML/XML named and numeric entities. */
export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return _m;
      }
    })
    .replace(/&#(\d+);/g, (_m, dec) => {
      try {
        return String.fromCodePoint(parseInt(dec, 10));
      } catch {
        return _m;
      }
    });
}

/**
 * Convert an HTML email body into readable plain text: drop <style>/<script>
 * blocks, turn block-level boundaries into newlines, strip remaining tags,
 * decode entities, and collapse extra blank lines.
 */
export function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n");
  text = text.replace(/<\/div>/gi, "\n");
  text = text.replace(/<\/li>/gi, "\n");
  text = text.replace(/<\/tr>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeHtmlEntities(text);
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/[ \t]+/g, " ");
  text = text.trim();
  return text;
}

export interface GmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

export interface ExtractedGmailBody {
  plain: string;
  html: string;
  attachments: GmailAttachment[];
}

/** Walk a Gmail message payload, collecting plain/HTML body text and attachment metadata. */
export function extractGmailBody(payload: any): ExtractedGmailBody {
  let plain = "";
  let html = "";
  const attachments: GmailAttachment[] = [];

  function walk(part: any): void {
    if (!part) return;

    if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType || "",
        size: part.body?.size ?? 0,
        attachmentId: part.body.attachmentId,
      });
    } else if (part.mimeType === "text/plain" && part.body?.data) {
      plain += Buffer.from(part.body.data, "base64url").toString("utf-8");
    } else if (part.mimeType === "text/html" && part.body?.data) {
      html += Buffer.from(part.body.data, "base64url").toString("utf-8");
    }

    if (part.parts) {
      part.parts.forEach(walk);
    }
  }

  walk(payload);
  return { plain, html, attachments };
}

export interface DraftMimeAttachment {
  filename: string;
  mimeType: string;
  data: Buffer;
}

export interface DraftMimeInput {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
  forward?: { from: string; date: string; subject: string; to: string; text: string };
  attachments?: DraftMimeAttachment[];
}

const CRLF = "\r\n";

/** RFC 2047 encoded-word for header values containing non-ASCII characters. */
export function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  // Split on code points so no multi-byte character is cut; keep each word under 75 chars.
  const words: string[] = [];
  let current = "";
  for (const ch of value) {
    if (Buffer.byteLength(current + ch, "utf-8") > 42) {
      words.push(current);
      current = "";
    }
    current += ch;
  }
  if (current) words.push(current);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf-8").toString("base64")}?=`).join(" ");
}

function wrap76(b64: string): string {
  return (b64.match(/.{1,76}/g) || []).join(CRLF);
}

function toCrlf(text: string): string {
  return text.replace(/\r\n|\r|\n/g, CRLF);
}

/** Build an RFC 5322 message for drafts: plain text, optional forwarded block and attachments. Pure; no network. */
export function buildDraftMime(input: DraftMimeInput): string {
  let text = input.body;
  if (input.forward) {
    const f = input.forward;
    text +=
      `\n\n---------- Forwarded message ---------\nFrom: ${f.from}\nDate: ${f.date}\n` +
      `Subject: ${f.subject}\nTo: ${f.to}\n\n${f.text}`;
  }
  const headers: string[] = [`To: ${input.to}`];
  if (input.cc) headers.push(`Cc: ${input.cc}`);
  if (input.bcc) headers.push(`Bcc: ${input.bcc}`);
  headers.push(`Subject: ${encodeHeaderValue(input.subject)}`);
  if (input.inReplyTo) headers.push(`In-Reply-To: ${input.inReplyTo}`);
  if (input.references) headers.push(`References: ${input.references}`);
  headers.push("MIME-Version: 1.0");

  const textPart = (): string[] => [
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(toCrlf(text), "utf-8").toString("base64")),
  ];

  const attachments = input.attachments || [];
  if (attachments.length === 0) {
    return [...headers, ...textPart()].join(CRLF) + CRLF;
  }

  const boundary = `=_multi_google_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const lines = [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, ...textPart()];
  for (const a of attachments) {
    const name = encodeHeaderValue(a.filename).replace(/"/g, "'");
    lines.push(
      `--${boundary}`,
      `Content-Type: ${a.mimeType || "application/octet-stream"}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrap76(a.data.toString("base64"))
    );
  }
  lines.push(`--${boundary}--`);
  return lines.join(CRLF) + CRLF;
}

export interface CreateDraftArgs {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  reply_to_message_id?: string;
  forward_message_id?: string;
  attachment_paths?: string[];
}

/** Resolve reply/forward/attachment arguments into the `message` body Gmail's drafts.create and drafts.update take. */
async function composeDraftMessage(
  gmail: any,
  args: CreateDraftArgs,
  readLocalFile: (path: string) => Buffer
): Promise<{ message: Record<string, string>; threadId: string | undefined }> {
  if (args.reply_to_message_id && args.forward_message_id) {
    throw new Error("Provide only one of reply_to_message_id and forward_message_id.");
  }
  const input: DraftMimeInput = {
    to: args.to,
    subject: args.subject,
    body: args.body,
    cc: args.cc,
    bcc: args.bcc,
    attachments: [],
  };
  let threadId: string | undefined;

  if (args.reply_to_message_id) {
    const orig = await gmail.users.messages.get({
      userId: "me",
      id: args.reply_to_message_id,
      format: "metadata",
      metadataHeaders: ["Message-ID", "References"],
    });
    const hs = orig.data.payload?.headers || [];
    const get = (n: string) => hs.find((h: any) => String(h.name).toLowerCase() === n.toLowerCase())?.value || "";
    const messageId = get("Message-ID");
    const refs = get("References");
    if (messageId) {
      input.inReplyTo = messageId;
      input.references = refs ? `${refs} ${messageId}` : messageId;
    } else if (refs) {
      input.references = refs;
    }
    threadId = orig.data.threadId || undefined;
  }

  if (args.forward_message_id) {
    const orig = await gmail.users.messages.get({ userId: "me", id: args.forward_message_id, format: "full" });
    const hs = orig.data.payload?.headers || [];
    const get = (n: string) => hs.find((h: any) => String(h.name).toLowerCase() === n.toLowerCase())?.value || "";
    const { plain, html, attachments } = orig.data.payload
      ? extractGmailBody(orig.data.payload)
      : { plain: "", html: "", attachments: [] as GmailAttachment[] };
    input.forward = {
      from: get("From"),
      date: get("Date"),
      subject: get("Subject"),
      to: get("To"),
      text: plain || (html ? htmlToText(html) : orig.data.snippet || ""),
    };
    for (const att of attachments) {
      const res = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId: args.forward_message_id,
        id: att.attachmentId,
      });
      input.attachments!.push({
        filename: att.filename,
        mimeType: att.mimeType,
        data: Buffer.from(res.data.data || "", "base64url"),
      });
    }
  }

  for (const path of args.attachment_paths || []) {
    if (!isAbsolute(path)) throw new Error(`attachment_paths entries must be absolute paths: ${path}`);
    input.attachments!.push({
      filename: basename(path),
      mimeType: "application/octet-stream",
      data: readLocalFile(path),
    });
  }

  const raw = Buffer.from(buildDraftMime(input), "utf-8").toString("base64url");
  const message: Record<string, string> = { raw };
  if (threadId) message.threadId = threadId;
  return { message, threadId };
}

/** Create a draft through an injected Gmail client (seam for tests). Returns draft id and thread id. */
export async function createDraft(
  gmail: any,
  args: CreateDraftArgs,
  readLocalFile: (path: string) => Buffer = (p) => readFileSync(p)
): Promise<{ draftId: string | null | undefined; threadId: string | null | undefined }> {
  const { message, threadId } = await composeDraftMessage(gmail, args, readLocalFile);
  const res = await gmail.users.drafts.create({ userId: "me", requestBody: { message } });
  return { draftId: res.data.id, threadId: res.data.message?.threadId || threadId };
}

/** Replace an existing draft's content (drafts.update) with the same arguments gmail_draft takes. */
export async function updateDraft(
  gmail: any,
  draftId: string,
  args: CreateDraftArgs,
  readLocalFile: (path: string) => Buffer = (p) => readFileSync(p)
): Promise<{ draftId: string | null | undefined; threadId: string | null | undefined }> {
  const { message, threadId } = await composeDraftMessage(gmail, args, readLocalFile);
  const res = await gmail.users.drafts.update({ userId: "me", id: draftId, requestBody: { id: draftId, message } });
  return { draftId: res.data.id, threadId: res.data.message?.threadId || threadId };
}

export async function deleteDraft(gmail: any, draftId: string): Promise<void> {
  await gmail.users.drafts.delete({ userId: "me", id: draftId });
}

function headerGetter(payload: any) {
  const hs: any[] = payload?.headers || [];
  return (name: string): string =>
    hs.find((h) => String(h.name).toLowerCase() === name.toLowerCase())?.value || "";
}

/** List drafts with headers only (id, message id, thread id, To, Subject, Date); never the body. */
export async function listDrafts(gmail: any, maxResults = 20) {
  const res = await gmail.users.drafts.list({ userId: "me", maxResults });
  const drafts: any[] = res.data.drafts || [];
  return Promise.all(
    drafts.map(async (d) => {
      const full = await gmail.users.drafts.get({
        userId: "me",
        id: d.id,
        format: "metadata",
        metadataHeaders: ["To", "Subject", "Date"],
      });
      const get = headerGetter(full.data.message?.payload);
      return {
        draft_id: d.id,
        message_id: full.data.message?.id ?? d.message?.id,
        thread_id: full.data.message?.threadId ?? d.message?.threadId,
        to: get("To"),
        subject: get("Subject"),
        date: get("Date"),
      };
    })
  );
}

export async function listAttachments(gmail: any, messageId: string): Promise<GmailAttachment[]> {
  const res = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  return res.data.payload ? extractGmailBody(res.data.payload).attachments : [];
}

export interface AttachmentFs {
  exists: (path: string) => boolean;
  mkdir: (dir: string) => void;
  write: (path: string, data: Buffer) => void;
}

const realFs: AttachmentFs = {
  exists: (p) => existsSync(p),
  mkdir: (d) => mkdirSync(d, { recursive: true }),
  // "wx" fails if the file appears between the check and the write.
  write: (p, data) => writeFileSync(p, data, { flag: "wx" }),
};

/** Write one attachment into dest_dir. Refuses to overwrite. Returns the saved path and byte count, never the content. */
export async function downloadAttachment(
  gmail: any,
  args: { message_id: string; attachment_id?: string; filename?: string; dest_dir: string },
  fsApi: AttachmentFs = realFs
): Promise<{ path: string; bytes: number }> {
  if (!isAbsolute(args.dest_dir)) throw new Error(`dest_dir must be an absolute path: ${args.dest_dir}`);
  if (!args.attachment_id && !args.filename) throw new Error("Provide attachment_id or filename.");
  const atts = await listAttachments(gmail, args.message_id);
  const att = args.attachment_id
    ? atts.find((a) => a.attachmentId === args.attachment_id)
    : atts.find((a) => a.filename === args.filename);
  if (!att) throw new Error("Attachment not found on that message. Use gmail_list_attachments.");
  // Strip any path components from the sender-controlled filename.
  const safeName = basename(att.filename.replace(/\\/g, "/")) || "attachment";
  const target = join(args.dest_dir, safeName);
  if (fsApi.exists(target)) throw new Error(`Refusing to overwrite existing file: ${target}`);
  const res = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId: args.message_id,
    id: att.attachmentId,
  });
  const data = Buffer.from(res.data.data || "", "base64url");
  fsApi.mkdir(args.dest_dir);
  fsApi.write(target, data);
  return { path: target, bytes: data.length };
}

/** Resolve label names (case-insensitive) or ids to ids through labels.list. */
export async function resolveLabelIds(gmail: any, labels: string[]): Promise<string[]> {
  if (labels.length === 0) return [];
  const res = await gmail.users.labels.list({ userId: "me" });
  const all: any[] = res.data.labels || [];
  return labels.map((l) => {
    const hit =
      all.find((x) => x.id === l) || all.find((x) => String(x.name).toLowerCase() === l.toLowerCase());
    if (!hit) throw new Error(`Label not found: "${l}". Use gmail_list_labels.`);
    return hit.id as string;
  });
}

export interface ModifyLabelsArgs {
  message_ids?: string[];
  thread_id?: string;
  add_labels?: string[];
  remove_labels?: string[];
}

/** Add and remove labels on messages or on a whole thread. Never trashes or deletes. */
export async function modifyLabels(gmail: any, args: ModifyLabelsArgs) {
  const hasMessages = !!args.message_ids && args.message_ids.length > 0;
  if (hasMessages === !!args.thread_id) throw new Error("Provide exactly one of message_ids or thread_id.");
  const addLabelIds = await resolveLabelIds(gmail, args.add_labels || []);
  const removeLabelIds = await resolveLabelIds(gmail, args.remove_labels || []);
  if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
    throw new Error("Provide at least one label in add_labels or remove_labels.");
  }
  if (hasMessages) {
    await gmail.users.messages.batchModify({
      userId: "me",
      requestBody: { ids: args.message_ids, addLabelIds, removeLabelIds },
    });
    return { modified: "messages", count: args.message_ids!.length, addLabelIds, removeLabelIds };
  }
  await gmail.users.threads.modify({
    userId: "me",
    id: args.thread_id,
    requestBody: { addLabelIds, removeLabelIds },
  });
  return { modified: "thread", thread_id: args.thread_id, addLabelIds, removeLabelIds };
}

/** Every message in a thread, in order, with plain-text bodies. */
export async function readThread(gmail: any, threadId: string) {
  const res = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
  const messages: any[] = res.data.messages || [];
  return messages.map((m) => {
    const get = headerGetter(m.payload);
    const { plain, html, attachments } = m.payload
      ? extractGmailBody(m.payload)
      : { plain: "", html: "", attachments: [] as GmailAttachment[] };
    return {
      id: m.id,
      from: get("From"),
      to: get("To"),
      cc: get("Cc"),
      date: get("Date"),
      subject: get("Subject"),
      body: plain || (html ? htmlToText(html) : m.snippet || ""),
      attachments: attachments.map((a) => a.filename),
    };
  });
}

/** Search several accounts; an account that fails reports its error in its own group. */
export async function searchAll(
  getClient: (account: string) => any | Promise<any>,
  allAccounts: string[],
  args: { query: string; accounts?: string[]; max_results?: number }
) {
  const accounts = args.accounts && args.accounts.length > 0 ? args.accounts : allAccounts;
  const groups = await Promise.all(
    accounts.map(async (account) => {
      try {
        const gmail = await getClient(account);
        const res = await gmail.users.messages.list({
          userId: "me",
          q: args.query,
          maxResults: args.max_results || 10,
        });
        const results = await Promise.all(
          (res.data.messages || []).map(async (msg: any) => {
            const full = await gmail.users.messages.get({
              userId: "me",
              id: msg.id,
              format: "metadata",
              metadataHeaders: ["From", "To", "Subject", "Date"],
            });
            const get = headerGetter(full.data.payload);
            return {
              id: msg.id,
              thread_id: full.data.threadId ?? msg.threadId,
              subject: get("Subject"),
              from: get("From"),
              to: get("To"),
              date: get("Date"),
              snippet: full.data.snippet,
            };
          })
        );
        return [account, { results }] as const;
      } catch (e) {
        return [account, { error: (e as Error).message }] as const;
      }
    })
  );
  return Object.fromEntries(groups);
}

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});
const acct = { type: "string" as const, description: "Account label" };
const draftProps = {
  to: { type: "string", description: "Recipient email address" },
  subject: { type: "string", description: "Email subject" },
  body: { type: "string", description: "Email body (plain text)" },
  cc: { type: "string", description: "CC recipients (comma-separated)" },
  bcc: { type: "string", description: "BCC recipients (comma-separated)" },
  reply_to_message_id: { type: "string", description: "Gmail message ID (same account) to reply to" },
  forward_message_id: { type: "string", description: "Gmail message ID (same account) to forward" },
  attachment_paths: { type: "array", items: { type: "string" }, description: "Absolute local file paths to attach" },
};

const baseGmailTools: ToolDef[] = [
  {
    name: "gmail_list_drafts",
    readOnly: true,
    description: `List drafts (id, message id, thread id, To, Subject, Date; no bodies). ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: { account: acct, max_results: { type: "number", description: "Max drafts (default 20)" } },
      required: ["account"],
    },
    handler: async (args: { account: string; max_results?: number }) =>
      text(await listDrafts(await getGmail(args.account), args.max_results)),
  },
  {
    name: "gmail_update_draft",
    readOnly: false,
    description: `Replace an existing draft's content. Same arguments as gmail_draft plus draft_id. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: { account: acct, draft_id: { type: "string", description: "Draft ID from gmail_list_drafts" }, ...draftProps },
      required: ["account", "draft_id", "to", "subject", "body"],
    },
    handler: async (args: { account: string; draft_id: string } & CreateDraftArgs) => {
      const { draftId, threadId } = await updateDraft(await getGmail(args.account), args.draft_id, args);
      return { content: [{ type: "text" as const, text: `Draft updated. Draft ID: ${draftId}. Thread ID: ${threadId ?? "none"}` }] };
    },
  },
  {
    name: "gmail_delete_draft",
    readOnly: false,
    description: `Delete a draft. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: { account: acct, draft_id: { type: "string", description: "Draft ID" } },
      required: ["account", "draft_id"],
    },
    handler: async (args: { account: string; draft_id: string }) => {
      await deleteDraft(await getGmail(args.account), args.draft_id);
      return { content: [{ type: "text" as const, text: `Draft ${args.draft_id} deleted.` }] };
    },
  },
  {
    name: "gmail_list_attachments",
    readOnly: true,
    description: `List a message's attachments (filename, MIME type, size, attachment id). ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: { account: acct, message_id: { type: "string", description: "Gmail message ID" } },
      required: ["account", "message_id"],
    },
    handler: async (args: { account: string; message_id: string }) =>
      text(await listAttachments(await getGmail(args.account), args.message_id)),
  },
  {
    name: "gmail_download_attachment",
    readOnly: false,
    description: `Save one attachment into dest_dir (absolute path). Refuses to overwrite an existing file. Returns the saved path and byte count, not the content. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: acct,
        message_id: { type: "string", description: "Gmail message ID" },
        attachment_id: { type: "string", description: "Attachment ID from gmail_list_attachments" },
        filename: { type: "string", description: "Attachment filename (alternative to attachment_id)" },
        dest_dir: { type: "string", description: "Absolute directory to save into" },
      },
      required: ["account", "message_id", "dest_dir"],
    },
    handler: async (args: { account: string; message_id: string; attachment_id?: string; filename?: string; dest_dir: string }) =>
      text(await downloadAttachment(await getGmail(args.account), args)),
  },
  {
    name: "gmail_modify_labels",
    readOnly: false,
    description: `Add or remove labels (by name or id) on messages (message_ids) or a whole thread (thread_id). Cannot trash or delete. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: acct,
        message_ids: { type: "array", items: { type: "string" }, description: "Message IDs (use this or thread_id)" },
        thread_id: { type: "string", description: "Thread ID (use this or message_ids)" },
        add_labels: { type: "array", items: { type: "string" }, description: "Label names or ids to add" },
        remove_labels: { type: "array", items: { type: "string" }, description: "Label names or ids to remove" },
      },
      required: ["account"],
    },
    handler: async (args: { account: string } & ModifyLabelsArgs) =>
      text(await modifyLabels(await getGmail(args.account), args)),
  },
  {
    name: "gmail_archive",
    readOnly: false,
    description: `Archive messages or a thread (removes the INBOX label). ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: acct,
        message_ids: { type: "array", items: { type: "string" }, description: "Message IDs (use this or thread_id)" },
        thread_id: { type: "string", description: "Thread ID (use this or message_ids)" },
      },
      required: ["account"],
    },
    handler: async (args: { account: string; message_ids?: string[]; thread_id?: string }) =>
      text(await modifyLabels(await getGmail(args.account), { ...args, remove_labels: ["INBOX"] })),
  },
  {
    name: "gmail_mark_read",
    readOnly: false,
    description: `Mark messages or a thread read (removes UNREAD); read: false marks them unread again. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: acct,
        message_ids: { type: "array", items: { type: "string" }, description: "Message IDs (use this or thread_id)" },
        thread_id: { type: "string", description: "Thread ID (use this or message_ids)" },
        read: { type: "boolean", description: "true (default) marks read; false marks unread" },
      },
      required: ["account"],
    },
    handler: async (args: { account: string; message_ids?: string[]; thread_id?: string; read?: boolean }) => {
      const { read, account, ...ids } = args;
      const labels = read === false ? { add_labels: ["UNREAD"] } : { remove_labels: ["UNREAD"] };
      return text(await modifyLabels(await getGmail(account), { ...ids, ...labels }));
    },
  },
  {
    name: "gmail_read_thread",
    readOnly: true,
    description: `Read every message in a thread, in order, with From, To, Cc, Date, Subject and plain-text body; attachments listed by name. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: { account: acct, thread_id: { type: "string", description: "Gmail thread ID" } },
      required: ["account", "thread_id"],
    },
    handler: async (args: { account: string; thread_id: string }) =>
      text(await readThread(await getGmail(args.account), args.thread_id)),
  },
  {
    name: "gmail_search_all",
    readOnly: true,
    description: `Search every configured account (or a subset) at once; results are grouped by account and one account failing does not fail the others. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Gmail search query" },
        accounts: { type: "array", items: { type: "string" }, description: "Account labels (default: all)" },
        max_results: { type: "number", description: "Max emails per account (default 10)" },
      },
      required: ["query"],
    },
    handler: async (args: { query: string; accounts?: string[]; max_results?: number }) =>
      text(await searchAll(getGmail, getAccountNames(), args)),
  },
  {
    name: "gmail_search",
    readOnly: true,
    description: `Search emails in a specific Google account. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account label (e.g. 'work', 'personal')" },
        query: { type: "string", description: "Gmail search query (same syntax as Gmail search bar)" },
        max_results: { type: "number", description: "Max emails to return (default 10)" },
      },
      required: ["account", "query"],
    },
    handler: async (args: { account: string; query: string; max_results?: number }) => {
      const gmail = await getGmail(args.account);
      const res = await gmail.users.messages.list({
        userId: "me",
        q: args.query,
        maxResults: args.max_results || 10,
      });

      if (!res.data.messages || res.data.messages.length === 0) {
        return { content: [{ type: "text" as const, text: "No messages found." }] };
      }

      const messages = await Promise.all(
        res.data.messages.map(async (msg) => {
          const full = await gmail.users.messages.get({
            userId: "me",
            id: msg.id!,
            format: "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date"],
          });
          const headers = full.data.payload?.headers || [];
          const get = (name: string) => headers.find((h) => h.name === name)?.value || "";
          return {
            id: msg.id,
            subject: get("Subject"),
            from: get("From"),
            to: get("To"),
            date: get("Date"),
            snippet: full.data.snippet,
          };
        })
      );

      return { content: [{ type: "text" as const, text: JSON.stringify(messages, null, 2) }] };
    },
  },
  {
    name: "gmail_read",
    readOnly: true,
    description: `Read a specific email by ID. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account label" },
        message_id: { type: "string", description: "Gmail message ID" },
      },
      required: ["account", "message_id"],
    },
    handler: async (args: { account: string; message_id: string }) => {
      const gmail = await getGmail(args.account);
      const res = await gmail.users.messages.get({
        userId: "me",
        id: args.message_id,
        format: "full",
      });

      const headers = res.data.payload?.headers || [];
      const get = (name: string) => headers.find((h) => h.name === name)?.value || "";

      const { plain, html, attachments } = res.data.payload
        ? extractGmailBody(res.data.payload)
        : { plain: "", html: "", attachments: [] as GmailAttachment[] };

      let body = "";
      let body_source: "text/plain" | "text/html" | "snippet";
      if (plain) {
        body = plain;
        body_source = "text/plain";
      } else if (html) {
        body = htmlToText(html);
        body_source = "text/html";
      } else {
        body = res.data.snippet || "";
        body_source = "snippet";
      }

      const email = {
        id: res.data.id,
        subject: get("Subject"),
        from: get("From"),
        to: get("To"),
        date: get("Date"),
        body,
        body_source,
        attachments,
        labels: res.data.labelIds,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(email, null, 2) }] };
    },
  },
  {
    name: "gmail_send",
    readOnly: false,
    description: `Send an email from a specific Google account. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account label" },
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body (plain text)" },
        cc: { type: "string", description: "CC recipients (comma-separated)" },
        bcc: { type: "string", description: "BCC recipients (comma-separated)" },
      },
      required: ["account", "to", "subject", "body"],
    },
    handler: async (args: { account: string; to: string; subject: string; body: string; cc?: string; bcc?: string }) => {
      const gmail = await getGmail(args.account);

      let headers = `To: ${args.to}\nSubject: ${args.subject}\nContent-Type: text/plain; charset=utf-8\n`;
      if (args.cc) headers += `Cc: ${args.cc}\n`;
      if (args.bcc) headers += `Bcc: ${args.bcc}\n`;

      const raw = Buffer.from(`${headers}\n${args.body}`).toString("base64url");

      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw },
      });

      return {
        content: [{ type: "text" as const, text: `Email sent. Message ID: ${res.data.id}` }],
      };
    },
  },
  {
    name: "gmail_draft",
    readOnly: false,
    description: `Create a draft email in a specific Google account. Optionally thread it as a reply (reply_to_message_id), make it a forward with the original attachments (forward_message_id), or attach local files. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account label" },
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body (plain text)" },
        cc: { type: "string", description: "CC recipients (comma-separated)" },
        bcc: { type: "string", description: "BCC recipients (comma-separated)" },
        reply_to_message_id: {
          type: "string",
          description: "Gmail message ID (same account) to reply to; the draft lands in that thread with In-Reply-To and References set",
        },
        forward_message_id: {
          type: "string",
          description: "Gmail message ID (same account) to forward; adds a forwarded-message block and re-attaches the original attachments. Not threaded.",
        },
        attachment_paths: {
          type: "array",
          items: { type: "string" },
          description: "Absolute local file paths to attach",
        },
      },
      required: ["account", "to", "subject", "body"],
    },
    handler: async (args: { account: string } & CreateDraftArgs) => {
      const gmail = await getGmail(args.account);
      const { draftId, threadId } = await createDraft(gmail, args);
      return {
        content: [{ type: "text" as const, text: `Draft created. Draft ID: ${draftId}. Thread ID: ${threadId ?? "none"}` }],
      };
    },
  },
  {
    name: "gmail_list_labels",
    readOnly: true,
    description: `List all labels in a Gmail account. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account label" },
      },
      required: ["account"],
    },
    handler: async (args: { account: string }) => {
      const gmail = await getGmail(args.account);
      const res = await gmail.users.labels.list({ userId: "me" });
      const labels = (res.data.labels || []).map((l) => ({ id: l.id, name: l.name, type: l.type }));
      return { content: [{ type: "text" as const, text: JSON.stringify(labels, null, 2) }] };
    },
  },
];

const GMAIL = "https://www.googleapis.com/auth/";
const GMAIL_COMPOSE = `${GMAIL}gmail.compose`;
const GMAIL_LABELS = `${GMAIL}gmail.labels`;
const GMAIL_SETTINGS_BASIC = `${GMAIL}gmail.settings.basic`;

const NEEDS = {
  modify: [SCOPE.gmailModify],
  send: [SCOPE.gmailModify, GMAIL_COMPOSE],
  labels: [SCOPE.gmailModify, GMAIL_LABELS],
  settings: [GMAIL_SETTINGS_BASIC],
  read: [SCOPE.gmailReadonly, SCOPE.gmailModify],
};

const LABEL_LIST_VISIBILITY = ["labelShow", "labelShowIfUnread", "labelHide"];
const MESSAGE_LIST_VISIBILITY = ["show", "hide"];

function ids(value: unknown, what: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v === "")) {
    throw new Error(`${what} must be an array of non-empty id strings.`);
  }
  return value as string[];
}

/** Move messages and/or threads to Trash, or restore them. Recoverable for 30 days; never permanent. */
export async function setTrashed(
  gmail: any,
  args: { message_ids?: string[]; thread_ids?: string[] },
  trashed: boolean
) {
  const messageIds = ids(args.message_ids, "message_ids");
  const threadIds = ids(args.thread_ids, "thread_ids");
  if (messageIds.length === 0 && threadIds.length === 0) {
    throw new Error("Provide message_ids and/or thread_ids.");
  }
  for (const id of messageIds) {
    await (trashed ? gmail.users.messages.trash({ userId: "me", id }) : gmail.users.messages.untrash({ userId: "me", id }));
  }
  for (const id of threadIds) {
    await (trashed ? gmail.users.threads.trash({ userId: "me", id }) : gmail.users.threads.untrash({ userId: "me", id }));
  }
  return { [trashed ? "trashed" : "untrashed"]: { messages: messageIds.length, threads: threadIds.length } };
}

export async function sendDraft(gmail: any, draftId: string) {
  if (!draftId) throw new Error("draft_id is required.");
  const res = await gmail.users.drafts.send({ userId: "me", requestBody: { id: draftId } });
  return { sent: true, message_id: res.data?.id, thread_id: res.data?.threadId };
}

export interface LabelArgs {
  name?: string;
  label_list_visibility?: string;
  message_list_visibility?: string;
  text_color?: string;
  background_color?: string;
}

function labelBody(args: LabelArgs, requireName: boolean) {
  const body: any = {};
  if (args.name !== undefined) body.name = args.name;
  else if (requireName) throw new Error("name is required.");
  if (args.label_list_visibility !== undefined) {
    if (!LABEL_LIST_VISIBILITY.includes(args.label_list_visibility)) {
      throw new Error(`label_list_visibility must be one of ${LABEL_LIST_VISIBILITY.join(", ")}.`);
    }
    body.labelListVisibility = args.label_list_visibility;
  }
  if (args.message_list_visibility !== undefined) {
    if (!MESSAGE_LIST_VISIBILITY.includes(args.message_list_visibility)) {
      throw new Error(`message_list_visibility must be one of ${MESSAGE_LIST_VISIBILITY.join(", ")}.`);
    }
    body.messageListVisibility = args.message_list_visibility;
  }
  if (args.text_color !== undefined || args.background_color !== undefined) {
    if (!args.text_color || !args.background_color) throw new Error("Set text_color and background_color together.");
    body.color = { textColor: args.text_color, backgroundColor: args.background_color };
  }
  return body;
}

export async function createLabel(gmail: any, args: LabelArgs) {
  const res = await gmail.users.labels.create({ userId: "me", requestBody: labelBody(args, true) });
  return res.data;
}

export async function updateLabel(gmail: any, args: LabelArgs & { label: string }) {
  const [id] = await resolveLabelIds(gmail, [args.label]);
  const requestBody = labelBody(args, false);
  if (Object.keys(requestBody).length === 0) throw new Error("Provide at least one field to change.");
  const res = await gmail.users.labels.patch({ userId: "me", id, requestBody });
  return res.data;
}

/** Deletes the label only; Gmail leaves the messages in place. System labels are refused by Gmail. */
export async function deleteLabel(gmail: any, label: string) {
  const [id] = await resolveLabelIds(gmail, [label]);
  await gmail.users.labels.delete({ userId: "me", id });
  return { deleted_label: id };
}

export async function listFilters(gmail: any) {
  const res = await gmail.users.settings.filters.list({ userId: "me" });
  return res.data.filter || [];
}

export interface FilterArgs {
  from?: string;
  to?: string;
  subject?: string;
  query?: string;
  negated_query?: string;
  has_attachment?: boolean;
  size?: number;
  size_comparison?: "larger" | "smaller";
  add_labels?: string[];
  remove_labels?: string[];
  mark_read?: boolean;
  archive?: boolean;
  star?: boolean;
  mark_important?: boolean;
  never_spam?: boolean;
}

/** Creates a standing rule applied to every future incoming message. Forwarding is not offered. */
export async function createFilter(gmail: any, args: FilterArgs) {
  const criteria: any = {};
  if (args.from) criteria.from = args.from;
  if (args.to) criteria.to = args.to;
  if (args.subject) criteria.subject = args.subject;
  if (args.query) criteria.query = args.query;
  if (args.negated_query) criteria.negatedQuery = args.negated_query;
  if (args.has_attachment !== undefined) criteria.hasAttachment = args.has_attachment;
  if (args.size !== undefined) {
    if (args.size_comparison !== "larger" && args.size_comparison !== "smaller") {
      throw new Error('size needs size_comparison "larger" or "smaller".');
    }
    criteria.size = args.size;
    criteria.sizeComparison = args.size_comparison;
  }
  if (Object.keys(criteria).length === 0) throw new Error("Provide at least one match criterion.");
  const addLabelIds = await resolveLabelIds(gmail, args.add_labels || []);
  const removeLabelIds = await resolveLabelIds(gmail, args.remove_labels || []);
  if (args.star) addLabelIds.push("STARRED");
  if (args.mark_important) addLabelIds.push("IMPORTANT");
  if (args.mark_read) removeLabelIds.push("UNREAD");
  if (args.archive) removeLabelIds.push("INBOX");
  if (args.never_spam) removeLabelIds.push("SPAM");
  if (addLabelIds.length === 0 && removeLabelIds.length === 0) throw new Error("Provide at least one action.");
  const action: any = {};
  if (addLabelIds.length) action.addLabelIds = addLabelIds;
  if (removeLabelIds.length) action.removeLabelIds = removeLabelIds;
  const res = await gmail.users.settings.filters.create({ userId: "me", requestBody: { criteria, action } });
  return res.data;
}

export async function deleteFilter(gmail: any, filterId: string) {
  if (!filterId) throw new Error("filter_id is required.");
  await gmail.users.settings.filters.delete({ userId: "me", id: filterId });
  return { deleted_filter: filterId };
}

export async function getVacation(gmail: any) {
  const res = await gmail.users.settings.getVacation({ userId: "me" });
  return res.data;
}

export interface VacationArgs {
  enabled: boolean;
  subject?: string;
  body_text?: string;
  body_html?: string;
  restrict_to_contacts?: boolean;
  restrict_to_domain?: boolean;
  start_time?: string;
  end_time?: string;
}

function epochMs(value: string, field: string): string {
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${field} must be an ISO date-time or epoch milliseconds.`);
  return String(ms);
}

/** Full replace of the auto-reply settings (users.settings.updateVacation is a PUT). */
export async function setVacation(gmail: any, args: VacationArgs) {
  if (typeof args.enabled !== "boolean") throw new Error("enabled (true or false) is required.");
  const requestBody: any = { enableAutoReply: args.enabled };
  if (args.subject !== undefined) requestBody.responseSubject = args.subject;
  if (args.body_text !== undefined) requestBody.responseBodyPlainText = args.body_text;
  if (args.body_html !== undefined) requestBody.responseBodyHtml = args.body_html;
  if (args.restrict_to_contacts !== undefined) requestBody.restrictToContacts = args.restrict_to_contacts;
  if (args.restrict_to_domain !== undefined) requestBody.restrictToDomain = args.restrict_to_domain;
  if (args.start_time !== undefined) requestBody.startTime = epochMs(args.start_time, "start_time");
  if (args.end_time !== undefined) requestBody.endTime = epochMs(args.end_time, "end_time");
  if (args.enabled && requestBody.responseBodyPlainText === undefined && requestBody.responseBodyHtml === undefined) {
    throw new Error("Enabling auto-reply needs body_text or body_html.");
  }
  const res = await gmail.users.settings.updateVacation({ userId: "me", requestBody });
  return res.data;
}

export async function listSendAs(gmail: any) {
  const res = await gmail.users.settings.sendAs.list({ userId: "me" });
  return (res.data.sendAs || []).map((s: any) => ({
    sendAsEmail: s.sendAsEmail,
    displayName: s.displayName,
    isPrimary: !!s.isPrimary,
    isDefault: !!s.isDefault,
    verificationStatus: s.verificationStatus,
    signature: s.signature,
  }));
}

export async function updateSignature(gmail: any, args: { send_as_email: string; signature: string }) {
  if (!args.send_as_email) throw new Error("send_as_email is required.");
  if (typeof args.signature !== "string") throw new Error("signature is required (empty string clears it).");
  const res = await gmail.users.settings.sendAs.patch({
    userId: "me",
    sendAsEmail: args.send_as_email,
    requestBody: { signature: args.signature },
  });
  return { sendAsEmail: res.data?.sendAsEmail ?? args.send_as_email, signature: res.data?.signature ?? args.signature };
}

export async function getProfile(gmail: any) {
  const res = await gmail.users.getProfile({ userId: "me" });
  return res.data;
}

export interface HistoryArgs {
  start_history_id: string;
  history_types?: string[];
  label_id?: string;
  max_results?: number;
  page_token?: string;
}

export async function listHistory(gmail: any, args: HistoryArgs) {
  if (!args.start_history_id) throw new Error("start_history_id is required (from gmail_get_profile or a prior call).");
  const res = await gmail.users.history.list({
    userId: "me",
    startHistoryId: args.start_history_id,
    historyTypes: args.history_types,
    labelId: args.label_id,
    maxResults: args.max_results ?? 100,
    pageToken: args.page_token,
  });
  return res.data;
}

const idList = (description: string) => ({ type: "array", items: { type: "string" }, description });
const labelFields = {
  label_list_visibility: { type: "string", enum: LABEL_LIST_VISIBILITY, description: "Show in the label list" },
  message_list_visibility: { type: "string", enum: MESSAGE_LIST_VISIBILITY, description: "Show on messages in the message list" },
  text_color: { type: "string", description: "Hex colour from Gmail's palette (e.g. #ffffff); set with background_color" },
  background_color: { type: "string", description: "Hex colour from Gmail's palette (e.g. #16a766); set with text_color" },
};

/**
 * Gmail tools beyond the original set. `getClient` and `scopes` are injectable
 * so tests can pass a fake client and a fixed granted-scope list.
 */
export function createGmailExtraTools(
  getClient: (account: string) => Promise<any> = getGmail,
  scopes: ScopeLookup = grantedScopes
): ToolDef[] {
  const run = <T>(account: string, needs: string[], fn: (gmail: any) => Promise<T>) =>
    withScope(account, needs, scopes, async () => text(await fn(await getClient(account))));
  const oneAccount = (properties: Record<string, unknown>, required: string[] = []) => ({
    type: "object" as const,
    properties: { account: acct, ...properties },
    required: ["account", ...required],
  });
  const acc = accountDescription;
  return [
    {
      name: "gmail_trash",
      readOnly: false,
      description: `Move messages (message_ids) and/or whole threads (thread_ids) to Trash. Recoverable with gmail_untrash for about 30 days; this server has no permanent delete. ${acc()}`,
      inputSchema: oneAccount({ message_ids: idList("Message IDs"), thread_ids: idList("Thread IDs") }),
      handler: async (a: any) => run(a.account, NEEDS.modify, (g) => setTrashed(g, a, true)),
    },
    {
      name: "gmail_untrash",
      readOnly: false,
      description: `Restore messages (message_ids) and/or threads (thread_ids) from Trash. ${acc()}`,
      inputSchema: oneAccount({ message_ids: idList("Message IDs"), thread_ids: idList("Thread IDs") }),
      handler: async (a: any) => run(a.account, NEEDS.modify, (g) => setTrashed(g, a, false)),
    },
    {
      name: "gmail_send_draft",
      readOnly: false,
      description: `SENDS an existing draft to its recipients immediately (cannot be undone). Draft IDs come from gmail_list_drafts or gmail_draft. ${acc()}`,
      inputSchema: oneAccount({ draft_id: { type: "string", description: "Draft ID" } }, ["draft_id"]),
      handler: async (a: any) => run(a.account, NEEDS.send, (g) => sendDraft(g, a.draft_id)),
    },
    {
      name: "gmail_create_label",
      readOnly: false,
      description: `Create a label (nest with "Parent/Child" in the name). Optional visibility and colour. ${acc()}`,
      inputSchema: oneAccount({ name: { type: "string", description: "Label name" }, ...labelFields }, ["name"]),
      handler: async (a: any) => run(a.account, NEEDS.labels, (g) => createLabel(g, a)),
    },
    {
      name: "gmail_update_label",
      readOnly: false,
      description: `Rename a label or change its visibility or colour. Only the fields you pass change. ${acc()}`,
      inputSchema: oneAccount(
        { label: { type: "string", description: "Existing label name or id" }, name: { type: "string", description: "New name" }, ...labelFields },
        ["label"]
      ),
      handler: async (a: any) => run(a.account, NEEDS.labels, (g) => updateLabel(g, a)),
    },
    {
      name: "gmail_delete_label",
      readOnly: false,
      description: `Delete a user label. Messages keep their other labels and stay in the mailbox; only the label is removed. ${acc()}`,
      inputSchema: oneAccount({ label: { type: "string", description: "Label name or id" } }, ["label"]),
      handler: async (a: any) => run(a.account, NEEDS.labels, (g) => deleteLabel(g, a.label)),
    },
    {
      name: "gmail_list_filters",
      readOnly: true,
      description: `List the account's filters (criteria and actions with ids). Needs the gmail.settings.basic scope. ${acc()}`,
      inputSchema: oneAccount({}),
      handler: async (a: any) => run(a.account, NEEDS.settings, (g) => listFilters(g)),
    },
    {
      name: "gmail_create_filter",
      readOnly: false,
      description: `Create a STANDING filter that acts on every future matching incoming message (label, archive, mark read, star, mark important, never spam). Needs at least one criterion and one action. Does not apply to existing mail and cannot forward. ${acc()}`,
      inputSchema: oneAccount({
        from: { type: "string" },
        to: { type: "string" },
        subject: { type: "string" },
        query: { type: "string", description: "Gmail search query the message must match" },
        negated_query: { type: "string", description: "Gmail search query the message must not match" },
        has_attachment: { type: "boolean" },
        size: { type: "number", description: "Bytes; needs size_comparison" },
        size_comparison: { type: "string", enum: ["larger", "smaller"] },
        add_labels: idList("Label names or ids to add"),
        remove_labels: idList("Label names or ids to remove"),
        mark_read: { type: "boolean" },
        archive: { type: "boolean", description: "Skip the inbox" },
        star: { type: "boolean" },
        mark_important: { type: "boolean" },
        never_spam: { type: "boolean" },
      }),
      handler: async (a: any) => run(a.account, NEEDS.settings, (g) => createFilter(g, a)),
    },
    {
      name: "gmail_delete_filter",
      readOnly: false,
      description: `Delete a filter by id (from gmail_list_filters). Mail already filtered is unchanged. ${acc()}`,
      inputSchema: oneAccount({ filter_id: { type: "string" } }, ["filter_id"]),
      handler: async (a: any) => run(a.account, NEEDS.settings, (g) => deleteFilter(g, a.filter_id)),
    },
    {
      name: "gmail_get_vacation",
      readOnly: true,
      description: `Read the auto-reply (vacation responder) settings. ${acc()}`,
      inputSchema: oneAccount({}),
      handler: async (a: any) => run(a.account, NEEDS.settings, (g) => getVacation(g)),
    },
    {
      name: "gmail_set_vacation",
      readOnly: false,
      description: `Turn the auto-reply on or off. When ON it automatically answers incoming senders until end_time or until turned off. Replaces all auto-reply settings, so pass every field you want kept. start_time and end_time are ISO date-times or epoch ms. ${acc()}`,
      inputSchema: oneAccount(
        {
          enabled: { type: "boolean" },
          subject: { type: "string" },
          body_text: { type: "string", description: "Plain-text reply" },
          body_html: { type: "string", description: "HTML reply" },
          restrict_to_contacts: { type: "boolean" },
          restrict_to_domain: { type: "boolean" },
          start_time: { type: "string" },
          end_time: { type: "string" },
        },
        ["enabled"]
      ),
      handler: async (a: any) => run(a.account, NEEDS.settings, (g) => setVacation(g, a)),
    },
    {
      name: "gmail_list_send_as",
      readOnly: true,
      description: `List send-as aliases with display name, verification status and current signature. ${acc()}`,
      inputSchema: oneAccount({}),
      handler: async (a: any) => run(a.account, NEEDS.settings, (g) => listSendAs(g)),
    },
    {
      name: "gmail_update_signature",
      readOnly: false,
      description: `Replace the signature on a send-as address; it is appended to every email sent from it from now on. HTML allowed; an empty string clears it. ${acc()}`,
      inputSchema: oneAccount(
        {
          send_as_email: { type: "string", description: "Address from gmail_list_send_as (the account's own address for the default)" },
          signature: { type: "string", description: "New signature (HTML)" },
        },
        ["send_as_email", "signature"]
      ),
      handler: async (a: any) => run(a.account, NEEDS.settings, (g) => updateSignature(g, a)),
    },
    {
      name: "gmail_get_profile",
      readOnly: true,
      description: `Account email address, message and thread totals, and the current historyId. ${acc()}`,
      inputSchema: oneAccount({}),
      handler: async (a: any) => run(a.account, NEEDS.read, (g) => getProfile(g)),
    },
    {
      name: "gmail_list_history",
      readOnly: true,
      description: `List mailbox changes (messages added/deleted, label changes) since a historyId from gmail_get_profile. Gmail keeps history for about a week; an expired id errors. ${acc()}`,
      inputSchema: oneAccount(
        {
          start_history_id: { type: "string" },
          history_types: { type: "array", items: { type: "string", enum: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"] } },
          label_id: { type: "string", description: "Only changes touching this label id" },
          max_results: { type: "number", description: "Default 100" },
          page_token: { type: "string" },
        },
        ["start_history_id"]
      ),
      handler: async (a: any) => run(a.account, NEEDS.read, (g) => listHistory(g, a)),
    },
  ];
}

export const gmailTools: ToolDef[] = [...baseGmailTools, ...createGmailExtraTools()];
