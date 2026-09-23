import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  buildWriteTabRequests,
  createDocsTools,
  injectTabId,
  structureOf,
  summarizeBody,
} from "../dist/tools/docs.js";
import { jsonSchemaToZod } from "../dist/schema.js";

type Tool = {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
};

function handler(tools: readonly Tool[], name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool.handler;
}

function json(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function para(start: number, text: string, extra: Record<string, unknown> = {}) {
  return {
    startIndex: start,
    endIndex: start + text.length + 1,
    paragraph: { elements: [{ textRun: { content: `${text}\n` } }], ...extra },
  };
}

const twoTabDoc = {
  documentId: "doc-1",
  title: "ME102B",
  tabs: [
    {
      tabProperties: { tabId: "t.0", title: "Plan", index: 0, nestingLevel: 0 },
      documentTab: { body: { content: [{ startIndex: 0, endIndex: 1, sectionBreak: {} }, para(1, "Plan")] } },
      childTabs: [
        {
          tabProperties: { tabId: "t.child", title: "Notes", index: 0, nestingLevel: 1, parentTabId: "t.0" },
          documentTab: { body: { content: [para(1, "child")] } },
        },
      ],
    },
    {
      tabProperties: { tabId: "t.yut", title: "Budget", index: 1, nestingLevel: 0 },
      documentTab: {
        body: {
          content: [
            para(1, "Item", { bullet: { listId: "kix.1", nestingLevel: 2 } }),
            { startIndex: 6, endIndex: 20, table: { rows: 2, columns: 3 } },
            para(20, "End"),
          ],
        },
      },
    },
  ],
};

function fakeClient(doc: unknown, sent: Record<string, unknown>[], gets: Record<string, unknown>[] = []) {
  return () =>
    ({
      documents: {
        get: async (request: Record<string, unknown>) => {
          gets.push(request);
          return { data: doc };
        },
        batchUpdate: async (request: Record<string, unknown>) => {
          sent.push(request);
          return { data: { documentId: "doc-1", replies: [{ addDocumentTab: { tabProperties: { tabId: "t.new" } } }] } };
        },
      },
    }) as never;
}

test("summarizes list nesting and tables", () => {
  const outline = summarizeBody(twoTabDoc.tabs[1].documentTab.body as never);
  assert.deepEqual(outline, [
    { startIndex: 1, endIndex: 6, style: "NORMAL_TEXT", text: "Item", bullet: { listId: "kix.1", level: 2 } },
    { startIndex: 6, endIndex: 20, style: "TABLE", text: "[table 2x3]" },
    { startIndex: 20, endIndex: 24, style: "NORMAL_TEXT", text: "End" },
  ]);
});

test("get_structure reads every tab, including nested ones, with includeTabsContent", async () => {
  const gets: Record<string, unknown>[] = [];
  const tools = createDocsTools(fakeClient(twoTabDoc, [], gets), () => []);
  const result = json(await handler(tools, "docs_get_structure")({ account: "berkeley", document_id: "doc-1" }));

  assert.equal(gets[0].includeTabsContent, true);
  assert.deepEqual(
    result.tabs.map((t: Record<string, unknown>) => [t.tabId, t.title, t.nestingLevel, t.parentTabId]),
    [
      ["t.0", "Plan", 0, undefined],
      ["t.child", "Notes", 1, "t.0"],
      ["t.yut", "Budget", 0, undefined],
    ]
  );
  assert.equal(result.tabs[2].paragraphs[2].text, "End");
});

test("get_structure with tab_id returns one tab in the single-tab shape", () => {
  const result = structureOf(twoTabDoc as never, "t.yut") as Record<string, any>;
  assert.equal(result.tabId, "t.yut");
  assert.equal(result.tabTitle, "Budget");
  assert.equal(result.paragraphs.length, 3);
  assert.equal(result.tabs, undefined);
  assert.throws(() => structureOf(twoTabDoc as never, "t.missing"), /t.missing not found.*t\.0 \(Plan\)/);
});

test("a single-tab doc still reads as documentId, title, paragraphs", () => {
  const single = { documentId: "d", title: "T", tabs: [twoTabDoc.tabs[1]] };
  const result = structureOf(single as never) as Record<string, any>;
  assert.deepEqual(Object.keys(result), ["documentId", "title", "tabId", "tabTitle", "paragraphs"]);
});

test("injects tab_id into every location and range lacking one, and nowhere else", () => {
  const original = [
    { insertText: { location: { index: 1 }, text: "x" } },
    { insertText: { endOfSegmentLocation: {}, text: "y" } },
    { updateTextStyle: { range: { startIndex: 1, endIndex: 2 }, textStyle: { bold: true }, fields: "bold" } },
    { deleteContentRange: { range: { startIndex: 1, endIndex: 2, tabId: "t.keep" } } },
    {
      updateTableCellStyle: {
        tableRange: { tableCellLocation: { tableStartLocation: { index: 5 }, rowIndex: 0 }, rowSpan: 1 },
        fields: "*",
      },
    },
    { replaceAllText: { containsText: { text: "a" }, replaceText: "b" } },
    { updateDocumentStyle: { documentStyle: {}, fields: "*" } },
    { deleteTab: { tabId: "t.other" } },
  ];
  const out = injectTabId(original as never, "t.yut") as any[];

  assert.equal(out[0].insertText.location.tabId, "t.yut");
  assert.equal(out[1].insertText.endOfSegmentLocation.tabId, "t.yut");
  assert.equal(out[2].updateTextStyle.range.tabId, "t.yut");
  assert.equal(out[2].updateTextStyle.textStyle.tabId, undefined);
  assert.equal(out[3].deleteContentRange.range.tabId, "t.keep");
  assert.equal(out[4].updateTableCellStyle.tableRange.tableCellLocation.tableStartLocation.tabId, "t.yut");
  assert.equal(out[4].updateTableCellStyle.tableRange.tabId, undefined);
  assert.deepEqual(out[5].replaceAllText.tabsCriteria, { tabIds: ["t.yut"] });
  assert.equal(out[6].updateDocumentStyle.tabId, "t.yut");
  assert.deepEqual(out[7], { deleteTab: { tabId: "t.other" } });
  assert.equal((original[0] as any).insertText.location.tabId, undefined, "input must not be mutated");
});

test("docs_batch_update sends injected requests only when tab_id is given", async () => {
  const sent: Record<string, unknown>[] = [];
  const tools = createDocsTools(fakeClient(twoTabDoc, sent), () => []);
  const requests = [{ insertText: { location: { index: 1 }, text: "x" } }];
  await handler(tools, "docs_batch_update")({ account: "b", document_id: "doc-1", requests });
  await handler(tools, "docs_batch_update")({ account: "b", document_id: "doc-1", requests, tab_id: "t.yut" });

  const bodies = sent.map((r) => (r.requestBody as { requests: any[] }).requests[0].insertText.location);
  assert.deepEqual(bodies, [{ index: 1 }, { index: 1, tabId: "t.yut" }]);
});

test("write_tab computes indices: clear, insert, style, then lists last-group-first", () => {
  const requests = buildWriteTabRequests("t.yut", 24, [
    { text: "Title", style: "HEADING_1" },
    { text: "one", list: "bullet" },
    { text: "two", list: "bullet", level: 1 },
    { text: "Body" },
    { text: "first", list: "numbered" },
  ]) as any[];

  // "Title\none\n\ttwo\nBody\nfirst" is 25 code units; the kept final newline ends it at 27.
  assert.deepEqual(requests[0], { deleteContentRange: { range: { startIndex: 1, endIndex: 23, tabId: "t.yut" } } });
  assert.deepEqual(requests[1], {
    insertText: { location: { index: 1, tabId: "t.yut" }, text: "Title\none\n\ttwo\nBody\nfirst" },
  });
  assert.deepEqual(requests[2].updateTextStyle.range, { startIndex: 1, endIndex: 26, tabId: "t.yut" });
  assert.deepEqual(requests[3].deleteParagraphBullets.range, { startIndex: 1, endIndex: 27, tabId: "t.yut" });

  const styles = requests.filter((r) => r.updateParagraphStyle).map((r) => r.updateParagraphStyle);
  assert.deepEqual(
    styles.map((s) => [s.range.startIndex, s.range.endIndex, s.paragraphStyle.namedStyleType]),
    [
      [1, 7, "HEADING_1"],
      [7, 11, "NORMAL_TEXT"],
      [11, 16, "NORMAL_TEXT"],
      [16, 21, "NORMAL_TEXT"],
      [21, 27, "NORMAL_TEXT"],
    ]
  );

  const lists = requests.filter((r) => r.createParagraphBullets).map((r) => r.createParagraphBullets);
  assert.deepEqual(lists, [
    { range: { startIndex: 21, endIndex: 27, tabId: "t.yut" }, bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN" },
    { range: { startIndex: 7, endIndex: 16, tabId: "t.yut" }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" },
  ]);
});

test("write_tab skips the delete on an empty tab and rejects bad input", () => {
  const requests = buildWriteTabRequests("t.0", 2, [{ text: "Hi" }]) as any[];
  assert.ok(!requests.some((r) => r.deleteContentRange));
  assert.throws(() => buildWriteTabRequests("t.0", 2, [{ text: "a\nb" }]), /newline/);
  assert.throws(() => buildWriteTabRequests("t.0", 2, [{ text: "a", style: "HEADING_9" }]), /unknown style/);
  assert.throws(() => buildWriteTabRequests("t.0", 2, [{ text: "a", list: "dash" }]), /unknown list/);
});

test("docs_write_tab reads the tab's own end index before writing", async () => {
  const sent: Record<string, unknown>[] = [];
  const tools = createDocsTools(fakeClient(twoTabDoc, sent), () => []);
  await handler(tools, "docs_write_tab")({
    account: "b",
    document_id: "doc-1",
    tab_id: "t.yut",
    paragraphs: [{ text: "New" }],
  });
  const first = (sent[0].requestBody as { requests: any[] }).requests[0];
  assert.deepEqual(first, { deleteContentRange: { range: { startIndex: 1, endIndex: 23, tabId: "t.yut" } } });
});

test("tab management tools send the verified request names", async () => {
  const sent: Record<string, unknown>[] = [];
  const tools = createDocsTools(fakeClient(twoTabDoc, sent), () => []);
  const added = json(
    await handler(tools, "docs_add_tab")({ account: "b", document_id: "doc-1", title: "New", parent_tab_id: "t.0" })
  );
  await handler(tools, "docs_rename_tab")({ account: "b", document_id: "doc-1", tab_id: "t.yut", title: "Cost" });
  await handler(tools, "docs_delete_tab")({ account: "b", document_id: "doc-1", tab_id: "t.yut", confirm_title: "Budget" });

  const requests = sent.map((r) => (r.requestBody as { requests: any[] }).requests[0]);
  assert.deepEqual(requests[0], { addDocumentTab: { tabProperties: { title: "New", parentTabId: "t.0" } } });
  assert.deepEqual(requests[1], {
    updateDocumentTabProperties: { tabProperties: { tabId: "t.yut", title: "Cost" }, fields: "title" },
  });
  assert.deepEqual(requests[2], { deleteTab: { tabId: "t.yut" } });
  assert.equal(added.tab.tabId, "t.new");
});

test("delete_tab refuses a wrong title, unconfirmed children, and the last tab", async () => {
  const sent: Record<string, unknown>[] = [];
  const tools = createDocsTools(fakeClient(twoTabDoc, sent), () => []);
  const del = handler(tools, "docs_delete_tab");
  await assert.rejects(del({ account: "b", document_id: "d", tab_id: "t.yut", confirm_title: "Plan" }), /does not match/);
  await assert.rejects(del({ account: "b", document_id: "d", tab_id: "t.0", confirm_title: "Plan" }), /child tabs/);

  const single = { tabs: [twoTabDoc.tabs[1]] };
  const soloTools = createDocsTools(fakeClient(single, sent), () => []);
  await assert.rejects(
    handler(soloTools, "docs_delete_tab")({ account: "b", document_id: "d", tab_id: "t.yut", confirm_title: "Budget" }),
    /only top-level tab/
  );
  assert.equal(sent.length, 0);
});

test("the MCP schema accepts request objects, not only strings", () => {
  const tools = createDocsTools(() => ({}) as never, () => []);
  const batch = tools.find((t) => t.name === "docs_batch_update")!;
  const schema = z.object(jsonSchemaToZod(batch.inputSchema));
  const parsed = schema.parse({
    account: "b",
    document_id: "d",
    requests: [{ insertText: { location: { index: 1 }, text: "x" } }, '{"deleteTab":{"tabId":"t.1"}}'],
  });
  assert.deepEqual(parsed.requests, [
    { insertText: { location: { index: 1 }, text: "x" } },
    { deleteTab: { tabId: "t.1" } },
  ]);

  const write = tools.find((t) => t.name === "docs_write_tab")!;
  const writeSchema = z.object(jsonSchemaToZod(write.inputSchema));
  const ok = writeSchema.parse({
    account: "b",
    document_id: "d",
    tab_id: "t.0",
    paragraphs: [{ text: "Hi", style: "HEADING_1", level: 0 }],
  });
  assert.equal(ok.paragraphs[0].style, "HEADING_1");
  assert.throws(() => writeSchema.parse({ account: "b", document_id: "d", tab_id: "t.0", paragraphs: [{}] }));
});
