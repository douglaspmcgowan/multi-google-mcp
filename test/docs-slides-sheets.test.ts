import assert from "node:assert/strict";
import test from "node:test";
import { SCOPES } from "../dist/config.js";
import { createDocsTools, summarizeDocument } from "../dist/tools/docs.js";
import {
  createSlidesTools,
  outlineToRequests,
  summarizePresentation,
} from "../dist/tools/slides.js";
import { createSheetsTools } from "../dist/tools/sheets.js";

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

test("auth/drive alone covers Docs, Slides and Sheets, so no re-consent is needed", () => {
  // Each of documents.batchUpdate, presentations.batchUpdate and
  // spreadsheets.batchUpdate accepts auth/drive as an alternative to its own
  // scope. If this assertion ever fails, the per-API scopes have to be added
  // and every account re-authorized.
  assert.ok(SCOPES.includes("https://www.googleapis.com/auth/drive"));
  assert.ok(!SCOPES.includes("https://www.googleapis.com/auth/documents"));
});

// ------------------------------------------------------------------- docs ---

test("summarizes a document to one entry per paragraph with its index range", () => {
  const outline = summarizeDocument({
    body: {
      content: [
        { startIndex: 0, endIndex: 1, sectionBreak: {} },
        {
          startIndex: 1,
          endIndex: 9,
          paragraph: {
            paragraphStyle: { namedStyleType: "HEADING_1" },
            elements: [{ textRun: { content: "Docket\n" } }],
          },
        },
        {
          startIndex: 9,
          endIndex: 20,
          paragraph: {
            elements: [{ textRun: { content: "Watch " } }, { textRun: { content: "first\n" } }],
          },
        },
      ],
    },
  } as never);

  assert.deepEqual(outline, [
    { startIndex: 1, endIndex: 9, style: "HEADING_1", text: "Docket" },
    { startIndex: 9, endIndex: 20, style: "NORMAL_TEXT", text: "Watch first" },
  ]);
});

test("replaces text in a doc without touching the rest of the file", async () => {
  const requests: Record<string, unknown>[] = [];
  const tools = createDocsTools(
    () =>
      ({
        documents: {
          get: async () => ({ data: {} }),
          batchUpdate: async (request: Record<string, unknown>) => {
            requests.push(request);
            return { data: { documentId: "doc-1", replies: [{}] } };
          },
        },
      }) as never,
    () => []
  );

  await handler(tools, "docs_replace_text")({
    account: "berkeley",
    document_id: "doc-1",
    replacements: [{ find: "old link", replace: "new link" }],
  });

  const body = requests[0].requestBody as { requests: Record<string, never>[] };
  assert.deepEqual(body.requests, [
    {
      replaceAllText: {
        containsText: { text: "old link", matchCase: true },
        replaceText: "new link",
      },
    },
  ]);
});

test("refuses an empty docs batch rather than sending a no-op request", async () => {
  const tools = createDocsTools(
    () => ({ documents: { get: async () => ({ data: {} }), batchUpdate: async () => ({ data: {} }) } }) as never,
    () => []
  );

  await assert.rejects(
    handler(tools, "docs_batch_update")({ account: "berkeley", document_id: "d", requests: [] }),
    /at least one/
  );
});

// ----------------------------------------------------------------- slides ---

test("summarizes a presentation to slide and shape object IDs with their text", () => {
  const outline = summarizePresentation({
    slides: [
      {
        objectId: "slide-a",
        pageElements: [
          { objectId: "title-a", shape: { text: { textElements: [{ textRun: { content: "Title\n" } }] } } },
          { objectId: "image-a", image: {} },
        ],
      },
    ],
  } as never);

  assert.deepEqual(outline, [
    { objectId: "slide-a", index: 0, elements: [{ objectId: "title-a", text: "Title" }] },
  ]);
});

test("builds a deck from an outline, mapping title and body placeholders", () => {
  const requests = outlineToRequests([{ title: "Week 1", bullets: ["Read the paper", "Try DaVinci"] }]);

  assert.equal(requests.length, 4);
  assert.deepEqual(requests[0], {
    createSlide: {
      objectId: "slide_0",
      slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
      placeholderIdMappings: [
        { layoutPlaceholder: { type: "TITLE" }, objectId: "slide_0_title" },
        { layoutPlaceholder: { type: "BODY" }, objectId: "slide_0_body" },
      ],
    },
  });
  assert.deepEqual(requests[1], { insertText: { objectId: "slide_0_title", text: "Week 1" } });
  assert.deepEqual(requests[2], {
    insertText: { objectId: "slide_0_body", text: "Read the paper\nTry DaVinci" },
  });
});

test("a title-only slide gets no body insert and no bullets", () => {
  assert.deepEqual(
    outlineToRequests([{ title: "Questions?" }]).map((request) => Object.keys(request)[0]),
    ["createSlide", "insertText"]
  );
});

test("sends the outline through presentations.batchUpdate", async () => {
  const requests: Record<string, unknown>[] = [];
  const tools = createSlidesTools(
    () =>
      ({
        presentations: {
          get: async () => ({ data: {} }),
          batchUpdate: async (request: Record<string, unknown>) => {
            requests.push(request);
            return { data: { presentationId: "deck-1" } };
          },
        },
      }) as never,
    () => []
  );

  await handler(tools, "slides_add_from_outline")({
    account: "berkeley",
    presentation_id: "deck-1",
    outline: [{ title: "Week 1" }],
  });

  assert.equal(requests[0].presentationId, "deck-1");
  const body = requests[0].requestBody as { requests: unknown[] };
  assert.equal(body.requests.length, 2);
});

// ----------------------------------------------------------------- sheets ---

test("writes a range as USER_ENTERED by default so formulas stay formulas", async () => {
  const calls: Record<string, unknown>[] = [];
  const tools = createSheetsTools(
    () =>
      ({
        spreadsheets: {
          get: async () => ({ data: {} }),
          batchUpdate: async () => ({ data: {} }),
          values: {
            get: async () => ({ data: {} }),
            append: async () => ({ data: {} }),
            update: async (request: Record<string, unknown>) => {
              calls.push(request);
              return { data: { updatedCells: 2 } };
            },
          },
        },
      }) as never,
    () => []
  );

  await handler(tools, "sheets_write_range")({
    account: "berkeley",
    spreadsheet_id: "sheet-1",
    range: "Sheet1!A1:B1",
    values: [["=SUM(C1:C2)", "text"]],
  });

  assert.equal(calls[0].valueInputOption, "USER_ENTERED");

  await handler(tools, "sheets_write_range")({
    account: "berkeley",
    spreadsheet_id: "sheet-1",
    range: "Sheet1!A1:B1",
    values: [["=SUM(C1:C2)", "text"]],
    raw: true,
  });

  assert.equal(calls[1].valueInputOption, "RAW");
});

test("appends rows without overwriting existing ones", async () => {
  const calls: Record<string, unknown>[] = [];
  const tools = createSheetsTools(
    () =>
      ({
        spreadsheets: {
          get: async () => ({ data: {} }),
          batchUpdate: async () => ({ data: {} }),
          values: {
            get: async () => ({ data: {} }),
            update: async () => ({ data: {} }),
            append: async (request: Record<string, unknown>) => {
              calls.push(request);
              return { data: { updates: { updatedRows: 1 } } };
            },
          },
        },
      }) as never,
    () => []
  );

  await handler(tools, "sheets_append_rows")({
    account: "berkeley",
    spreadsheet_id: "sheet-1",
    range: "Sheet1!A:C",
    values: [["a", "b", "c"]],
  });

  assert.equal(calls[0].insertDataOption, "INSERT_ROWS");
});

test("reads a range through the values API, which does not truncate", async () => {
  const rows = Array.from({ length: 300 }, (_, index) => [String(index)]);
  const tools = createSheetsTools(
    () =>
      ({
        spreadsheets: {
          get: async () => ({ data: {} }),
          batchUpdate: async () => ({ data: {} }),
          values: {
            update: async () => ({ data: {} }),
            append: async () => ({ data: {} }),
            get: async () => ({ data: { values: rows } }),
          },
        },
      }) as never,
    () => []
  );

  const result = json(
    await handler(tools, "sheets_read_range")({
      account: "berkeley",
      spreadsheet_id: "sheet-1",
      range: "Sheet1",
    })
  );

  assert.equal(result.values.length, 300);
});

// ------------------------------------------------------- no delete surface ---

test("none of the three expose a delete-the-whole-thing tool", () => {
  const names = [
    ...createDocsTools(() => ({}) as never, () => []),
    ...createSlidesTools(() => ({}) as never, () => []),
    ...createSheetsTools(() => ({}) as never, () => []),
  ].map((tool) => tool.name);

  for (const forbidden of ["docs_delete", "slides_delete", "sheets_delete", "docs_clear"]) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not exist`);
  }
});
