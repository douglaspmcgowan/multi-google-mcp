import { google } from "googleapis";
import { getAuthenticatedClient } from "../auth.js";
import { getAccountNames } from "../config.js";

function getGmail(account: string) {
  const auth = getAuthenticatedClient(account);
  return google.gmail({ version: "v1", auth });
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

export const gmailTools = [
  {
    name: "gmail_search",
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
      const gmail = getGmail(args.account);
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
      const gmail = getGmail(args.account);
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
      const gmail = getGmail(args.account);

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
    description: `Create a draft email in a specific Google account. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account label" },
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body (plain text)" },
      },
      required: ["account", "to", "subject", "body"],
    },
    handler: async (args: { account: string; to: string; subject: string; body: string }) => {
      const gmail = getGmail(args.account);

      const raw = Buffer.from(
        `To: ${args.to}\nSubject: ${args.subject}\nContent-Type: text/plain; charset=utf-8\n\n${args.body}`
      ).toString("base64url");

      const res = await gmail.users.drafts.create({
        userId: "me",
        requestBody: { message: { raw } },
      });

      return {
        content: [{ type: "text" as const, text: `Draft created. Draft ID: ${res.data.id}` }],
      };
    },
  },
  {
    name: "gmail_list_labels",
    description: `List all labels in a Gmail account. ${accountDescription()}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account label" },
      },
      required: ["account"],
    },
    handler: async (args: { account: string }) => {
      const gmail = getGmail(args.account);
      const res = await gmail.users.labels.list({ userId: "me" });
      const labels = (res.data.labels || []).map((l) => ({ id: l.id, name: l.name, type: l.type }));
      return { content: [{ type: "text" as const, text: JSON.stringify(labels, null, 2) }] };
    },
  },
];
