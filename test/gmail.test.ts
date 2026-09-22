import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText, decodeHtmlEntities, extractGmailBody } from "../src/tools/gmail.js";

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
