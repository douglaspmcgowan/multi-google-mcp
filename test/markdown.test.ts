import assert from "node:assert/strict";
import test from "node:test";
import { bodyToMarkdown, headingUrl, parseInline, parseMarkdown } from "../dist/markdown.js";
import { buildAppendRequests, buildWriteTabRequests, createDocsTools } from "../dist/tools/docs.js";

type Tool = {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
};

function handler(tools: readonly Tool[], name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool.handler;
}

const json = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

test("parseInline turns bold, italic, code and links into runs", () => {
  const out = parseInline("A **bold** and *it* with `x()` see [site](https://e.com) \\*lit\\*");
  assert.equal(out.text, "A bold and it with x() see site *lit*");
  assert.deepEqual(out.runs, [
    { start: 2, end: 6, bold: true },
    { start: 11, end: 13, italic: true },
    { start: 19, end: 22, code: true },
    { start: 27, end: 31, link: "https://e.com" },
  ]);
});

test("parseInline keeps an unmatched delimiter and snake_case literal", () => {
  assert.deepEqual(parseInline("2 * 3 = 6"), { text: "2 * 3 = 6", runs: [] });
  assert.deepEqual(parseInline("file_name_here"), { text: "file_name_here", runs: [] });
});

test("parseMarkdown handles headings, nested lists, numbered, code fences, quotes, soft wraps", () => {
  const md = [
    "# Title",
    "",
    "Intro line one",
    "continues here.",
    "",
    "- top",
    "  - nested **b**",
    "    - deeper",
    "- back",
    "",
    "1. first",
    "2. second",
    "",
    "```",
    "const x = 1;",
    "```",
    "> quoted",
    "---",
  ].join("\n");
  const paras = parseMarkdown(md);
  assert.deepEqual(
    paras.map((p) => [p.text, p.style ?? "", p.list ?? "", p.level ?? "", !!p.code]),
    [
      ["Title", "HEADING_1", "", "", false],
      ["Intro line one continues here.", "", "", "", false],
      ["top", "", "bullet", 0, false],
      ["nested b", "", "bullet", 1, false],
      ["deeper", "", "bullet", 2, false],
      ["back", "", "bullet", 0, false],
      ["first", "", "numbered", 0, false],
      ["second", "", "numbered", 0, false],
      ["const x = 1;", "", "", "", true],
      ["quoted", "", "", "", false],
    ]
  );
  assert.deepEqual(paras[3].runs, [{ start: 7, end: 8, bold: true }]);
  assert.deepEqual(paras[9].runs, [{ start: 0, end: 6, italic: true }]);
});

test("write requests style inline runs after the leading list tabs, before bullets", () => {
  const paras = parseMarkdown("- a **b**\n  - c [d](https://x.y)");
  const requests = buildWriteTabRequests("t.0", 1, paras) as any[];
  // text: "a b\n\tc d" -> first paragraph [1,5), second [5,10) with tab at 5.
  assert.equal(requests[0].insertText.text, "a b\n\tc d");
  const inline = requests.filter((r) => r.updateTextStyle && r.updateTextStyle.fields !== "*");
  assert.deepEqual(
    inline.map((r) => [r.updateTextStyle.range.startIndex, r.updateTextStyle.range.endIndex, r.updateTextStyle.fields]),
    [
      [3, 4, "bold"],
      [8, 9, "link"],
    ]
  );
  const lastInline = requests.lastIndexOf(inline[inline.length - 1]);
  const firstBullet = requests.findIndex((r) => r.createParagraphBullets);
  assert.ok(lastInline < firstBullet, "inline styles must precede createParagraphBullets");
  assert.throws(() => buildWriteTabRequests("t.0", 1, [{ text: "ab", runs: [{ start: 1, end: 5, bold: true }] }]), /run outside/);
});

test("code-block paragraphs are set monospace", () => {
  const requests = buildWriteTabRequests("t.0", 1, [{ text: "x = 1", code: true }]) as any[];
  const mono = requests.find((r) => r.updateTextStyle?.fields === "weightedFontFamily");
  assert.deepEqual(mono.updateTextStyle.range, { startIndex: 1, endIndex: 6, tabId: "t.0" });
});

const para = (start: number, text: string, extra: Record<string, unknown> = {}) => ({
  startIndex: start,
  endIndex: start + text.length + 1,
  paragraph: { elements: [{ textRun: { content: `${text}\n` } }], ...extra },
});

test("append after a non-empty last paragraph inserts a newline first and never deletes", () => {
  const body = { content: [{ startIndex: 0, endIndex: 1, sectionBreak: {} }, para(1, "Existing")] };
  const requests = buildAppendRequests("t.9", body as never, [
    { text: "2026-09-23", style: "HEADING_2" },
    { text: "note", list: "bullet" },
  ]) as any[];
  assert.ok(!requests.some((r) => r.deleteContentRange));
  assert.deepEqual(requests[0], { insertText: { location: { index: 9, tabId: "t.9" }, text: "\n2026-09-23\nnote" } });
  const styles = requests.filter((r) => r.updateParagraphStyle).map((r) => r.updateParagraphStyle.range);
  assert.deepEqual(styles, [
    { startIndex: 10, endIndex: 21, tabId: "t.9" },
    { startIndex: 21, endIndex: 26, tabId: "t.9" },
  ]);
  assert.deepEqual(requests.find((r) => r.deleteParagraphBullets).deleteParagraphBullets.range, {
    startIndex: 10,
    endIndex: 26,
    tabId: "t.9",
  });
});

test("append reuses an empty last paragraph", () => {
  const body = { content: [para(1, "Existing"), para(10, "")] };
  const requests = buildAppendRequests("t.0", body as never, [{ text: "new" }]) as any[];
  assert.deepEqual(requests[0], { insertText: { location: { index: 10, tabId: "t.0" }, text: "new" } });
});

const richDoc = {
  documentId: "doc-9",
  title: "Rich",
  tabs: [
    {
      tabProperties: { tabId: "t.0", title: "Main", index: 0 },
      documentTab: {
        lists: {
          "kix.num": { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } },
          "kix.bul": { listProperties: { nestingLevels: [{ glyphSymbol: "●" }, { glyphSymbol: "○" }] } },
        },
        body: {
          content: [
            {
              startIndex: 1,
              endIndex: 7,
              paragraph: {
                paragraphStyle: { namedStyleType: "HEADING_1", headingId: "h.abc" },
                elements: [{ textRun: { content: "Intro\n" } }],
              },
            },
            {
              startIndex: 7,
              endIndex: 30,
              paragraph: {
                elements: [
                  { textRun: { content: "Say " } },
                  { textRun: { content: "bold ", textStyle: { bold: true } } },
                  { textRun: { content: "run", textStyle: { weightedFontFamily: { fontFamily: "Courier New" } } } },
                  { textRun: { content: " link", textStyle: { link: { url: "https://e.com" } } } },
                  { textRun: { content: "\n" } },
                ],
              },
            },
            para(30, "one", { bullet: { listId: "kix.num", nestingLevel: 0 } }),
            para(34, "dot", { bullet: { listId: "kix.bul", nestingLevel: 0 } }),
            para(38, "sub", { bullet: { listId: "kix.bul", nestingLevel: 1 } }),
            {
              startIndex: 42,
              endIndex: 60,
              table: {
                rows: 2,
                columns: 2,
                tableRows: [
                  { tableCells: [{ content: [para(0, "A")] }, { content: [para(0, "B")] }] },
                  { tableCells: [{ content: [para(0, "1")] }, { content: [para(0, "2")] }] },
                ],
              },
            },
            {
              startIndex: 60,
              endIndex: 66,
              paragraph: {
                paragraphStyle: { namedStyleType: "HEADING_2", headingId: "h.def" },
                elements: [{ textRun: { content: "Next\n" } }],
              },
            },
          ],
        },
      },
    },
    {
      tabProperties: { tabId: "t.two", title: "Second", index: 1 },
      documentTab: {
        body: {
          content: [
            {
              startIndex: 1,
              endIndex: 7,
              paragraph: {
                paragraphStyle: { namedStyleType: "HEADING_1", headingId: "h.zzz" },
                elements: [{ textRun: { content: "Intro\n" } }],
              },
            },
          ],
        },
      },
    },
  ],
};

test("bodyToMarkdown renders headings, inline styles, ordered vs bullet lists and tables", () => {
  const tab = richDoc.tabs[0].documentTab;
  assert.equal(
    bodyToMarkdown(tab.body as never, tab.lists as never),
    [
      "# Intro",
      "",
      "Say **bold** `run` [link](https://e.com)",
      "",
      "1. one",
      "- dot",
      "  - sub",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "## Next",
      "",
    ].join("\n")
  );
});

function docsClient(doc: unknown, sent: any[] = [], created: any[] = []) {
  return () =>
    ({
      documents: {
        get: async () => ({ data: doc }),
        create: async (req: any) => {
          created.push(req);
          return { data: { documentId: "new-doc" } };
        },
        batchUpdate: async (req: any) => {
          sent.push(req);
          return { data: {} };
        },
      },
    }) as never;
}

test("docs_read_markdown reads one tab, or every tab with separators", async () => {
  const tools = createDocsTools(docsClient(richDoc), () => []);
  const one = (await handler(tools, "docs_read_markdown")({ account: "b", document_id: "doc-9", tab_id: "t.two" })).content[0].text;
  assert.equal(one, "# Intro\n");
  const all = (await handler(tools, "docs_read_markdown")({ account: "b", document_id: "doc-9" })).content[0].text;
  assert.match(all, /^<!-- tab t\.0: Main -->/);
  assert.match(all, /<!-- tab t\.two: Second -->\n\n# Intro/);
});

test("docs_heading_link builds tab + heading URLs and prefers exact matches", async () => {
  const tools = createDocsTools(docsClient(richDoc), () => []);
  const link = handler(tools, "docs_heading_link");
  const next = json(await link({ account: "b", document_id: "doc-9", heading: "next" }));
  assert.equal(next.url, "https://docs.google.com/document/d/doc-9/edit?tab=t.0#heading=h.def");
  const intro = json(await link({ account: "b", document_id: "doc-9", heading: "Intro" }));
  assert.equal(intro.matches.length, 2, "same heading in two tabs returns both");
  const scoped = json(await link({ account: "b", document_id: "doc-9", heading: "Intro", tab_id: "t.two" }));
  assert.equal(scoped.url, headingUrl("doc-9", "t.two", "h.zzz"));
  const byId = json(await link({ account: "b", document_id: "doc-9", heading_id: "h.abc" }));
  assert.equal(byId.tabId, "t.0");
  const list = json(await link({ account: "b", document_id: "doc-9" }));
  assert.equal(list.headings.length, 3);
  await assert.rejects(link({ account: "b", document_id: "doc-9", heading: "missing" }), /no heading matches/);
});

test("docs_write_markdown replace mode writes into the named tab", async () => {
  const sent: any[] = [];
  const tools = createDocsTools(docsClient(richDoc, sent), () => []);
  const out = json(
    await handler(tools, "docs_write_markdown")({ account: "b", document_id: "doc-9", tab_id: "t.two", markdown: "# Hi\n\n- x" })
  );
  assert.equal(out.created, false);
  const reqs = sent[0].requestBody.requests;
  assert.deepEqual(reqs[0], { deleteContentRange: { range: { startIndex: 1, endIndex: 6, tabId: "t.two" } } });
  assert.equal(reqs[1].insertText.text, "Hi\nx");
  await assert.rejects(
    handler(tools, "docs_write_markdown")({ account: "b", document_id: "doc-9", markdown: "x" }),
    /needs tab_id/
  );
});

test("docs_write_markdown create mode uses documents.create, or Drive when a folder is given", async () => {
  const fresh = { documentId: "new-doc", tabs: [{ tabProperties: { tabId: "t.0" }, documentTab: { body: { content: [para(1, "")] } } }] };
  const sent: any[] = [];
  const created: any[] = [];
  const driveCalls: any[] = [];
  const drive = () =>
    ({
      files: {
        create: async (req: any) => {
          driveCalls.push(req);
          return { data: { id: "new-doc" } };
        },
      },
    }) as never;
  const tools = createDocsTools(docsClient(fresh, sent, created), () => [], drive);
  const out = json(await handler(tools, "docs_write_markdown")({ account: "b", title: "Notes", markdown: "**hi**" }));
  assert.deepEqual(created[0], { requestBody: { title: "Notes" } });
  assert.equal(out.documentId, "new-doc");
  assert.equal(out.created, true);
  assert.ok(!sent[0].requestBody.requests.some((r: any) => r.deleteContentRange));

  await handler(tools, "docs_write_markdown")({ account: "b", title: "N2", parent_id: "folder-1", markdown: "x" });
  assert.deepEqual(driveCalls[0].requestBody.parents, ["folder-1"]);
  assert.equal(driveCalls[0].requestBody.mimeType, "application/vnd.google-apps.document");
});

test("docs_append_to_tab adds a dated heading and never deletes", async () => {
  const sent: any[] = [];
  const tools = createDocsTools(docsClient(richDoc, sent), () => [], undefined, () => new Date(2026, 8, 23, 10));
  await handler(tools, "docs_append_to_tab")({
    account: "b",
    document_id: "doc-9",
    tab_id: "t.two",
    heading: "Standup",
    date_prefix: true,
    markdown: "- done",
  });
  const reqs = sent[0].requestBody.requests;
  assert.ok(!reqs.some((r: any) => r.deleteContentRange));
  assert.deepEqual(reqs[0], { insertText: { location: { index: 6, tabId: "t.two" }, text: "\n2026-09-23 — Standup\ndone" } });
  await assert.rejects(
    handler(tools, "docs_append_to_tab")({ account: "b", document_id: "doc-9", tab_id: "t.two", markdown: "a", paragraphs: [] }),
    /not both/
  );
});
