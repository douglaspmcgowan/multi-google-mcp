import { getAuthenticatedClient } from "../auth.js";
import { getAccountNames } from "../config.js";

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

      // Extract body text
      let body = "";
      function extractText(part: any): void {
        if (part.mimeType === "text/plain" && part.body?.data) {
          body += Buffer.from(part.body.data, "base64url").toString("utf-8");
        }
        if (part.parts) {
          part.parts.forEach(extractText);
        }
      }

      if (res.data.payload) {
        extractText(res.data.payload);
      }

      // Fallback to snippet if no plain text found
      if (!body && res.data.snippet) {
        body = res.data.snippet;
      }

      const email = {
        id: res.data.id,
        subject: get("Subject"),
        from: get("From"),
        to: get("To"),
        date: get("Date"),
        body,
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
      const gmail = await getGmail(args.account);

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
      const gmail = await getGmail(args.account);
      const res = await gmail.users.labels.list({ userId: "me" });
      const labels = (res.data.labels || []).map((l) => ({ id: l.id, name: l.name, type: l.type }));
      return { content: [{ type: "text" as const, text: JSON.stringify(labels, null, 2) }] };
    },
  },
];
