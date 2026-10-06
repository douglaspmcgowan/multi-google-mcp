import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText, decodeHtmlEntities, extractGmailBody, buildDraftMime, createDraft } from "../src/tools/gmail.js";

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
