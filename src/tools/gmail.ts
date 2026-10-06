import { getAuthenticatedClient } from "../auth.js";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { getAccountNames } from "../config.js";
import type { ToolDef } from "./types.js";

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

export const gmailTools: ToolDef[] = [
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
