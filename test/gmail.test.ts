import { test } from "node:test";
import assert from "node:assert/strict";
import {
  htmlToText,
  decodeHtmlEntities,
  extractGmailBody,
  buildDraftMime,
  createDraft,
  updateDraft,
  deleteDraft,
  listDrafts,
  listAttachments,
  downloadAttachment,
  modifyLabels,
  readThread,
  searchAll,
  type AttachmentFs,
} from "../src/tools/gmail.js";

function b64url(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64url");
}

test("decodeHtmlEntities decodes named and numeric entities", () => {
  assert.equal(decodeHtmlEntities("A&amp;B"), "A&B");
  assert.equal(decodeHtmlEntities("&lt;tag&gt;"), "<tag>");
  assert.equal(decodeHtmlEntities("&quot;quoted&quot;"), '"quoted"');
  assert.equal(decodeHtmlEntities("It&#39;s"), "It's");
  assert.equal(decodeHtmlEntities("&#65;&#66;&#67;"), "ABC");
  assert.equal(decodeHtmlEntities("&#x41;&#x42;"), "AB");
  assert.equal(decodeHtmlEntities("a&nbsp;b"), "a b");
});

test("htmlToText strips style/script and converts block boundaries to newlines", () => {
  const html = `
    <html><head><style>body { color: red; }</style>
    <script>alert('hi');</script></head>
    <body>
      <p>Hello there,</p>
      <div>Your registration is <b>confirmed</b>.</div>
      <ul><li>Item one</li><li>Item two</li></ul>
      <table><tr><td>Row A</td></tr><tr><td>Row B</td></tr></table>
      Line one<br>Line two
    </body></html>
  `;
  const text = htmlToText(html);

  assert.ok(!text.includes("color: red"), "style contents should be dropped");
  assert.ok(!text.includes("alert("), "script contents should be dropped");
  assert.ok(!text.includes("<"), "no tags should remain");
  assert.ok(text.includes("Hello there,"));
  assert.ok(text.includes("Your registration is confirmed."));
  assert.ok(text.includes("Item one"));
  assert.ok(text.includes("Item two"));
  assert.ok(text.includes("Row A"));
  assert.ok(text.includes("Row B"));
  assert.ok(text.includes("Line one"));
  assert.ok(text.includes("Line two"));
});

test("htmlToText decodes entities and collapses blank lines", () => {
  const html = "<p>Fees &amp; deadlines &#8212; see &lt;portal&gt;</p>\n\n\n\n<p>Next paragraph</p>";
  const text = htmlToText(html);
  assert.ok(text.includes("Fees & deadlines"));
  assert.ok(text.includes("<portal>"));
  assert.ok(!/\n{3,}/.test(text), "blank line runs should be collapsed");
});

test("extractGmailBody prefers text/plain when present", () => {
  const payload = {
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/plain", body: { data: b64url("Plain body text") } },
      { mimeType: "text/html", body: { data: b64url("<p>HTML body text</p>") } },
    ],
  };
  const { plain, html, attachments } = extractGmailBody(payload);
  assert.equal(plain, "Plain body text");
  assert.equal(html, "<p>HTML body text</p>");
  assert.equal(attachments.length, 0);
});

test("extractGmailBody falls back to html-only body and lists attachments", () => {
  // Simulates an HTML-only registrar notice with no text/plain part.
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [{ mimeType: "text/html", body: { data: b64url("<p>Your hold has been <b>cleared</b>.</p>") } }],
      },
      {
        filename: "notice.pdf",
        mimeType: "application/pdf",
        body: { attachmentId: "att-123", size: 4096 },
      },
    ],
  };
  const { plain, html, attachments } = extractGmailBody(payload);
  assert.equal(plain, "");
  assert.equal(html, "<p>Your hold has been <b>cleared</b>.</p>");
  assert.equal(attachments.length, 1);
  assert.deepEqual(attachments[0], {
    filename: "notice.pdf",
    mimeType: "application/pdf",
    size: 4096,
    attachmentId: "att-123",
  });

  const bodyText = htmlToText(html);
  assert.ok(bodyText.includes("Your hold has been cleared."));
});

test("extractGmailBody returns nothing when payload has neither plain nor html", () => {
  const payload = {
    mimeType: "multipart/mixed",
    parts: [{ filename: "image.png", mimeType: "image/png", body: { attachmentId: "att-999", size: 10 } }],
  };
  const { plain, html, attachments } = extractGmailBody(payload);
  assert.equal(plain, "");
  assert.equal(html, "");
  assert.equal(attachments.length, 1);
  // Handler-level fallback (not exercised here) would use body_source "snippet" in this case.
});

function parseMime(raw: string) {
  const [head, ...rest] = raw.split("\r\n\r\n");
  return { head, rest: rest.join("\r\n\r\n") };
}

test("buildDraftMime builds a plain CRLF message and round-trips the body", () => {
  const mime = buildDraftMime({ to: "a@x.com", subject: "Hi", body: "line1\nline2" });
  assert.ok(!/[^\r]\n/.test(mime), "only CRLF line endings");
  const { head, rest } = parseMime(mime);
  assert.ok(head.includes("To: a@x.com"));
  assert.ok(head.includes("Subject: Hi"));
  assert.ok(!head.includes("Cc:"));
  assert.equal(Buffer.from(rest.replace(/\r\n/g, ""), "base64").toString("utf-8"), "line1\r\nline2");
});

test("buildDraftMime includes cc, bcc and reply headers", () => {
  const mime = buildDraftMime({
    to: "a@x.com", subject: "Re: Hi", body: "b", cc: "c@x.com", bcc: "d@x.com",
    inReplyTo: "<m2@x>", references: "<m1@x> <m2@x>",
  });
  assert.ok(mime.includes("Cc: c@x.com\r\n"));
  assert.ok(mime.includes("Bcc: d@x.com\r\n"));
  assert.ok(mime.includes("In-Reply-To: <m2@x>\r\n"));
  assert.ok(mime.includes("References: <m1@x> <m2@x>\r\n"));
});

test("buildDraftMime encodes a non-ASCII subject per RFC 2047", () => {
  const mime = buildDraftMime({ to: "a@x.com", subject: "Réunion à 15h — café", body: "b" });
  const line = mime.split("\r\n").find((l) => l.startsWith("Subject:"))!;
  assert.ok(/^Subject: =\?UTF-8\?B\?/.test(line));
  const decoded = [...line.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)]
    .map((m) => Buffer.from(m[1], "base64").toString("utf-8")).join("");
  assert.equal(decoded, "Réunion à 15h — café");
});

test("buildDraftMime adds a forward block and a binary attachment that round-trips", () => {
  const data = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256));
  const mime = buildDraftMime({
    to: "a@x.com", subject: "Fwd: S", body: "see below",
    forward: { from: "f@x.com", date: "Mon", subject: "S", to: "me@x.com", text: "orig text" },
    attachments: [{ filename: "a.bin", mimeType: "application/octet-stream", data }],
  });
  assert.ok(mime.includes('Content-Type: multipart/mixed; boundary="'));
  const boundary = /boundary="([^"]+)"/.exec(mime)![1];
  const parts = mime.split(`--${boundary}`).slice(1, -1);
  assert.equal(parts.length, 2);
  const textBody = parts[0].split("\r\n\r\n")[1].replace(/\r\n/g, "");
  const text = Buffer.from(textBody, "base64").toString("utf-8");
  assert.ok(text.includes("---------- Forwarded message ---------"));
  assert.ok(text.includes("From: f@x.com") && text.includes("Subject: S") && text.includes("orig text"));
  const attBody = parts[1].split("\r\n\r\n")[1].trim();
  assert.ok(attBody.split("\r\n").every((l) => l.length <= 76), "76-column wrapping");
  assert.ok(parts[1].includes('filename="a.bin"'));
  assert.deepEqual(Buffer.from(attBody.replace(/\r\n/g, ""), "base64"), data);
});

function fakeGmail(messages: Record<string, any>, attachments: Record<string, string> = {}) {
  const created: any[] = [];
  const gmail = {
    users: {
      messages: {
        get: async ({ id }: any) => ({ data: messages[id] }),
        attachments: { get: async ({ id }: any) => ({ data: { data: attachments[id] } }) },
      },
      drafts: {
        create: async (req: any) => {
          created.push(req);
          return { data: { id: "d1", message: { threadId: req.requestBody.message.threadId || "newthread" } } };
        },
      },
    },
  };
  return { gmail, created };
}

test("createDraft threads a reply and sets headers", async () => {
  const { gmail, created } = fakeGmail({
    m1: { threadId: "t9", payload: { headers: [{ name: "Message-ID", value: "<m1@x>" }, { name: "References", value: "<m0@x>" }] } },
  });
  const out = await createDraft(gmail, { to: "a@x.com", subject: "Re: S", body: "ok", reply_to_message_id: "m1" });
  assert.equal(created[0].requestBody.message.threadId, "t9");
  const mime = Buffer.from(created[0].requestBody.message.raw, "base64url").toString("utf-8");
  assert.ok(mime.includes("In-Reply-To: <m1@x>"));
  assert.ok(mime.includes("References: <m0@x> <m1@x>"));
  assert.deepEqual(out, { draftId: "d1", threadId: "t9" });
});

test("createDraft forwards with original attachments and does not thread", async () => {
  const bin = Buffer.from([0, 1, 2, 250, 251, 252]);
  const { gmail, created } = fakeGmail(
    {
      m2: {
        threadId: "t2",
        payload: {
          mimeType: "multipart/mixed",
          headers: [{ name: "From", value: "f@x.com" }, { name: "Date", value: "Mon" }, { name: "Subject", value: "S" }, { name: "To", value: "me@x.com" }],
          parts: [
            { mimeType: "text/plain", body: { data: Buffer.from("orig").toString("base64url") } },
            { filename: "p.pdf", mimeType: "application/pdf", body: { attachmentId: "att1", size: 6 } },
          ],
        },
      },
    },
    { att1: bin.toString("base64url") }
  );
  await createDraft(gmail, { to: "a@x.com", subject: "Fwd: S", body: "fyi", forward_message_id: "m2" });
  assert.equal(created[0].requestBody.message.threadId, undefined);
  const mime = Buffer.from(created[0].requestBody.message.raw, "base64url").toString("utf-8");
  assert.ok(mime.includes('filename="p.pdf"') && mime.includes("application/pdf"));
});

test("createDraft rejects relative attachment paths and reply plus forward together", async () => {
  const { gmail } = fakeGmail({});
  await assert.rejects(() => createDraft(gmail, { to: "a", subject: "s", body: "b", attachment_paths: ["rel.txt"] }), /absolute/);
  await assert.rejects(() => createDraft(gmail, { to: "a", subject: "s", body: "b", reply_to_message_id: "1", forward_message_id: "2" }), /only one/);
});

const hdr = (name: string, value: string) => ({ name, value });

test("listDrafts returns headers only, never the body", async () => {
  const gets: any[] = [];
  const gmail = {
    users: {
      drafts: {
        list: async (req: any) => {
          assert.equal(req.maxResults, 5);
          return { data: { drafts: [{ id: "d1", message: { id: "m1", threadId: "t1" } }] } };
        },
        get: async (req: any) => {
          gets.push(req);
          return {
            data: {
              message: {
                id: "m1",
                threadId: "t1",
                snippet: "SECRET BODY",
                payload: { headers: [hdr("To", "a@x.com"), hdr("Subject", "Hi"), hdr("Date", "Mon")] },
              },
            },
          };
        },
      },
    },
  };
  const out = await listDrafts(gmail, 5);
  assert.deepEqual(out, [
    { draft_id: "d1", message_id: "m1", thread_id: "t1", to: "a@x.com", subject: "Hi", date: "Mon" },
  ]);
  assert.equal(gets[0].format, "metadata");
  assert.ok(!JSON.stringify(out).includes("SECRET"));
});

test("updateDraft calls drafts.update with the rebuilt message and deleteDraft calls drafts.delete", async () => {
  const calls: any = {};
  const gmail = {
    users: {
      drafts: {
        update: async (req: any) => {
          calls.update = req;
          return { data: { id: "d1", message: { threadId: "t9" } } };
        },
        delete: async (req: any) => {
          calls.delete = req;
          return { data: {} };
        },
      },
    },
  };
  const res = await updateDraft(gmail, "d1", { to: "a@x.com", subject: "New", body: "text" });
  assert.equal(calls.update.id, "d1");
  assert.equal(calls.update.requestBody.id, "d1");
  const mime = Buffer.from(calls.update.requestBody.message.raw, "base64url").toString("utf-8");
  assert.ok(mime.includes("Subject: New"));
  assert.equal(res.threadId, "t9");
  await deleteDraft(gmail, "d1");
  assert.deepEqual(calls.delete, { userId: "me", id: "d1" });
});

function attachmentGmail() {
  return {
    users: {
      messages: {
        get: async () => ({
          data: {
            payload: {
              mimeType: "multipart/mixed",
              parts: [
                { mimeType: "text/plain", body: { data: b64url("hi") } },
                { filename: "a.pdf", mimeType: "application/pdf", body: { attachmentId: "att1", size: 3 } },
              ],
            },
          },
        }),
        attachments: { get: async () => ({ data: { data: Buffer.from("PDF").toString("base64url") } }) },
      },
    },
  };
}

test("listAttachments reports filename, type, size and id", async () => {
  assert.deepEqual(await listAttachments(attachmentGmail(), "m1"), [
    { filename: "a.pdf", mimeType: "application/pdf", size: 3, attachmentId: "att1" },
  ]);
});

test("downloadAttachment writes into dest_dir and returns path and byte count only", async () => {
  const writes: Array<{ path: string; data: Buffer }> = [];
  const fsApi: AttachmentFs = {
    exists: () => false,
    mkdir: () => {},
    write: (path, data) => void writes.push({ path, data }),
  };
  const dir = process.platform === "win32" ? "C:\\dl" : "/dl";
  const out = await downloadAttachment(attachmentGmail(), { message_id: "m1", filename: "a.pdf", dest_dir: dir }, fsApi);
  assert.equal(out.bytes, 3);
  assert.ok(out.path.endsWith("a.pdf"));
  assert.equal(writes[0].data.toString(), "PDF");
  assert.ok(!JSON.stringify(out).includes("PDF"));
});

test("downloadAttachment refuses to overwrite and rejects a relative dest_dir", async () => {
  let wrote = false;
  const fsApi: AttachmentFs = { exists: () => true, mkdir: () => {}, write: () => void (wrote = true) };
  const dir = process.platform === "win32" ? "C:\\dl" : "/dl";
  await assert.rejects(
    () => downloadAttachment(attachmentGmail(), { message_id: "m1", attachment_id: "att1", dest_dir: dir }, fsApi),
    /overwrite/
  );
  assert.equal(wrote, false);
  await assert.rejects(
    () => downloadAttachment(attachmentGmail(), { message_id: "m1", attachment_id: "att1", dest_dir: "rel" }, fsApi),
    /absolute/
  );
});

function labelGmail() {
  const calls: any = {};
  const gmail = {
    users: {
      labels: {
        list: async () => ({
          data: { labels: [{ id: "INBOX", name: "INBOX" }, { id: "UNREAD", name: "UNREAD" }, { id: "Label_7", name: "Receipts" }] },
        }),
      },
      messages: { batchModify: async (r: any) => void (calls.batch = r) },
      threads: { modify: async (r: any) => void (calls.thread = r) },
    },
  };
  return { gmail, calls };
}

test("modifyLabels resolves label names to ids for messages and for a thread", async () => {
  const { gmail, calls } = labelGmail();
  await modifyLabels(gmail, { message_ids: ["m1", "m2"], add_labels: ["receipts"], remove_labels: ["INBOX"] });
  assert.deepEqual(calls.batch.requestBody, { ids: ["m1", "m2"], addLabelIds: ["Label_7"], removeLabelIds: ["INBOX"] });
  await modifyLabels(gmail, { thread_id: "t1", add_labels: ["Label_7"] });
  assert.deepEqual(calls.thread, { userId: "me", id: "t1", requestBody: { addLabelIds: ["Label_7"], removeLabelIds: [] } });
});

test("modifyLabels rejects unknown labels and ambiguous targets", async () => {
  const { gmail } = labelGmail();
  await assert.rejects(() => modifyLabels(gmail, { message_ids: ["m"], add_labels: ["Nope"] }), /Label not found/);
  await assert.rejects(() => modifyLabels(gmail, { add_labels: ["INBOX"] }), /exactly one/);
  await assert.rejects(() => modifyLabels(gmail, { message_ids: ["m"], thread_id: "t", add_labels: ["INBOX"] }), /exactly one/);
});

test("readThread returns every message in order with plain-text bodies and attachment names", async () => {
  const gmail = {
    users: {
      threads: {
        get: async () => ({
          data: {
            messages: [
              {
                id: "m1",
                payload: {
                  headers: [hdr("From", "a@x.com"), hdr("To", "b@x.com"), hdr("Cc", "c@x.com"), hdr("Date", "Mon"), hdr("Subject", "S")],
                  mimeType: "multipart/mixed",
                  parts: [
                    { mimeType: "text/plain", body: { data: b64url("first") } },
                    { filename: "f.txt", mimeType: "text/plain", body: { attachmentId: "x", size: 1 } },
                  ],
                },
              },
              { id: "m2", payload: { headers: [hdr("From", "b@x.com")], mimeType: "text/html", body: { data: b64url("<p>second</p>") } } },
            ],
          },
        }),
      },
    },
  };
  const out = await readThread(gmail, "t1");
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { id: "m1", from: "a@x.com", to: "b@x.com", cc: "c@x.com", date: "Mon", subject: "S", body: "first", attachments: ["f.txt"] });
  assert.equal(out[1].body, "second");
});

test("searchAll groups by account and isolates a failing account", async () => {
  const good = {
    users: {
      messages: {
        list: async (r: any) => {
          assert.equal(r.q, "is:unread");
          return { data: { messages: [{ id: "m1" }] } };
        },
        get: async () => ({
          data: { threadId: "t1", snippet: "snip", payload: { headers: [hdr("Subject", "S"), hdr("From", "f")] } },
        }),
      },
    },
  };
  const getClient = async (account: string) => {
    if (account === "broken") throw new Error("Authentication expired");
    return good;
  };
  const out: any = await searchAll(getClient, ["a", "broken"], { query: "is:unread" });
  assert.equal(out.a.results[0].id, "m1");
  assert.equal(out.a.results[0].thread_id, "t1");
  assert.match(out.broken.error, /Authentication expired/);
  const only: any = await searchAll(getClient, ["a", "broken"], { query: "is:unread", accounts: ["a"] });
  assert.deepEqual(Object.keys(only), ["a"]);
});
