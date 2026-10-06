import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDriveTools } from "../dist/tools/drive.js";
import { createFormsTools } from "../dist/tools/forms.js";
import { createSheetsTools, columnName, parseStartCell } from "../dist/tools/sheets.js";
import { createSlidesTools, readPresentationText } from "../dist/tools/slides.js";
import { createCommentTools } from "../dist/tools/comments.js";

type Tool = {
  name: string;
  readOnly: boolean;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
};
type Call = { method: string; request: Record<string, unknown> };

function find(tools: readonly Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}
const json = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

/** A fake client where every `a.b.c(...)` call is recorded and answered from `answers["a.b.c"]`. */
function fake(answers: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const build = (pathParts: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, key: string) => (key === "then" ? undefined : build([...pathParts, key])),
      apply: async (_t, _this, [request]: [Record<string, unknown>]) => {
        const method = pathParts.join(".");
        calls.push({ method, request });
        const answer = answers[method];
        return { data: typeof answer === "function" ? (answer as (r: unknown) => unknown)(request) : (answer ?? {}) };
      },
    });
  return { client: build([]) as never, calls };
}

const names = () => [];

// ---------- Drive ----------

test("drive_list_folder lists children of a folder with paging and shared-drive flags", async () => {
  const { client, calls } = fake({ "files.list": { files: [{ id: "a" }], nextPageToken: "next" } });
  const tools = createDriveTools(() => client, names) as Tool[];
  const tool = find(tools, "drive_list_folder");
  assert.equal(tool.readOnly, true);
  const out = json(await tool.handler({ account: "p", folder_id: "fo'lder", page_size: 5000, page_token: "tok" }));
  assert.equal(out.nextPageToken, "next");
  assert.equal(out.count, 1);
  const req = calls[0].request;
  assert.equal(req.q, "'fo\\'lder' in parents and trashed = false");
  assert.equal(req.pageSize, 1000);
  assert.equal(req.pageToken, "tok");
  assert.equal(req.supportsAllDrives, true);
  assert.equal(req.includeItemsFromAllDrives, true);
  assert.match(String(req.fields), /owners\(/);
});

test("drive_list_shared_drives lists drives", async () => {
  const { client, calls } = fake({ "drives.list": { drives: [{ id: "d1", name: "Lab" }] } });
  const tool = find(createDriveTools(() => client, names) as Tool[], "drive_list_shared_drives");
  assert.equal(tool.readOnly, true);
  const out = json(await tool.handler({ account: "p", query: "name contains 'Lab'" }));
  assert.equal(out.drives[0].id, "d1");
  assert.equal(calls[0].request.q, "name contains 'Lab'");
  assert.equal(calls[0].request.pageSize, 100);
});

test("drive_list_revisions and drive_download_revision hit the revisions resource", async () => {
  const { client, calls } = fake({ "revisions.list": { revisions: [{ id: "r1" }] } });
  const tools = createDriveTools(() => client, names) as Tool[];
  const list = find(tools, "drive_list_revisions");
  assert.equal(list.readOnly, true);
  assert.equal(json(await list.handler({ account: "p", file_id: "f" })).revisions[0].id, "r1");
  assert.equal(calls[0].request.fileId, "f");

  const dl = find(tools, "drive_download_revision");
  assert.equal(dl.readOnly, false);
  const { Readable } = await import("node:stream");
  const streamClient = {
    revisions: {
      get: async (request: Record<string, unknown>, options: Record<string, unknown>) => {
        calls.push({ method: "revisions.get", request: { ...request, ...options } });
        return { data: Readable.from([Buffer.from("old bytes")]) };
      },
    },
  } as never;
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rev-")), "x", "old.bin");
  const tools2 = createDriveTools(() => streamClient, names) as Tool[];
  const out = json(await find(tools2, "drive_download_revision").handler({ account: "p", file_id: "f", revision_id: "r1", destination_path: dest }));
  assert.equal(out.byteCount, 9);
  assert.equal(fs.readFileSync(dest, "utf8"), "old bytes");
  const get = calls.find((c) => c.method === "revisions.get")!;
  assert.equal(get.request.revisionId, "r1");
  assert.equal(get.request.alt, "media");
  assert.equal(get.request.responseType, "stream");
});

test("drive_update_permission changes role and expiry, and validates input", async () => {
  const { client, calls } = fake();
  const tool = find(createDriveTools(() => client, names) as Tool[], "drive_update_permission");
  await tool.handler({ account: "p", file_id: "f", permission_id: "perm", role: "commenter", expiration_time: "2027-01-01T00:00:00Z" });
  assert.equal(calls[0].method, "permissions.update");
  assert.deepEqual(calls[0].request.requestBody, { role: "commenter", expirationTime: "2027-01-01T00:00:00Z" });
  assert.equal(calls[0].request.permissionId, "perm");
  assert.equal(calls[0].request.supportsAllDrives, true);
  await assert.rejects(() => tool.handler({ account: "p", file_id: "f", permission_id: "perm", role: "owner" }), /role must be/);
  await assert.rejects(() => tool.handler({ account: "p", file_id: "f", permission_id: "perm" }), /needs role or expiration_time/);
});

test("drive_transfer_ownership uses pending owner for gmail.com and direct for Workspace", async () => {
  const { client, calls } = fake({ "permissions.list": { permissions: [{ id: "p1", emailAddress: "Me@Gmail.com" }] } });
  const tool = find(createDriveTools(() => client, names) as Tool[], "drive_transfer_ownership");
  const consumer = json(await tool.handler({ account: "p", file_id: "f", email: "me@gmail.com" }));
  assert.equal(consumer.mode, "pending");
  const update = calls.find((c) => c.method === "permissions.update")!;
  assert.equal(update.request.permissionId, "p1");
  assert.deepEqual(update.request.requestBody, { role: "writer", pendingOwner: true });
  assert.equal(update.request.transferOwnership, undefined);

  calls.length = 0;
  const direct = json(await tool.handler({ account: "p", file_id: "f", email: "boss@corp.edu" }));
  assert.equal(direct.mode, "direct");
  const create = calls.find((c) => c.method === "permissions.create")!;
  assert.equal(create.request.transferOwnership, true);
  assert.deepEqual(create.request.requestBody, { type: "user", emailAddress: "boss@corp.edu", role: "owner" });
  await assert.rejects(() => tool.handler({ account: "p", file_id: "f", email: "x@y.z", mode: "bogus" }), /mode must be/);
});

test("drive_set_link_sharing creates, updates and removes link permissions", async () => {
  const state = { permissions: [] as Array<Record<string, unknown>> };
  const { client, calls } = fake({ "permissions.list": () => state });
  const tool = find(createDriveTools(() => client, names) as Tool[], "drive_set_link_sharing");

  await tool.handler({ account: "p", file_id: "f", access: "anyone" });
  const create = calls.find((c) => c.method === "permissions.create")!;
  assert.deepEqual(create.request.requestBody, { type: "anyone", role: "reader", allowFileDiscovery: false });

  calls.length = 0;
  await tool.handler({ account: "p", file_id: "f", access: "domain", domain: "berkeley.edu", role: "commenter" });
  assert.deepEqual(calls.find((c) => c.method === "permissions.create")!.request.requestBody, {
    type: "domain", role: "commenter", allowFileDiscovery: false, domain: "berkeley.edu",
  });
  await assert.rejects(() => tool.handler({ account: "p", file_id: "f", access: "domain" }), /needs domain/);
  await assert.rejects(() => tool.handler({ account: "p", file_id: "f", access: "world" }), /access must be/);

  state.permissions = [{ id: "link1", type: "anyone" }, { id: "u1", type: "user" }];
  calls.length = 0;
  await tool.handler({ account: "p", file_id: "f", access: "anyone", role: "writer" });
  const update = calls.find((c) => c.method === "permissions.update")!;
  assert.equal(update.request.permissionId, "link1");
  assert.deepEqual(update.request.requestBody, { role: "writer" });

  calls.length = 0;
  const off = json(await tool.handler({ account: "p", file_id: "f", access: "off" }));
  assert.deepEqual(off.removed, ["link1"]);
  const del = calls.filter((c) => c.method === "permissions.delete");
  assert.equal(del.length, 1);
  assert.equal(del[0].request.permissionId, "link1");
});

test("drive_star and drive_update_metadata send the right update bodies", async () => {
  const { client, calls } = fake();
  const tools = createDriveTools(() => client, names) as Tool[];
  await find(tools, "drive_star").handler({ account: "p", file_id: "f", starred: false });
  assert.deepEqual(calls[0].request.requestBody, { starred: false });
  await find(tools, "drive_update_metadata").handler({ account: "p", file_id: "f", description: "", properties: { k: "v", old: null } });
  assert.deepEqual(calls[1].request.requestBody, { description: "", properties: { k: "v", old: null } });
  await assert.rejects(() => find(tools, "drive_update_metadata").handler({ account: "p", file_id: "f" }), /needs description or properties/);
});

test("drive_get_storage_quota reads about.storageQuota", async () => {
  const { client, calls } = fake({ "about.get": { storageQuota: { limit: "100", usage: "5" } } });
  const tool = find(createDriveTools(() => client, names) as Tool[], "drive_get_storage_quota");
  assert.equal(tool.readOnly, true);
  assert.equal(json(await tool.handler({ account: "p" })).storageQuota.usage, "5");
  assert.match(String(calls[0].request.fields), /storageQuota/);
});

test("search, metadata and permission reads pass the shared-drive flags", async () => {
  const { client, calls } = fake({ "files.get": { parents: ["old"] } });
  const tools = createDriveTools(() => client, names) as Tool[];
  await find(tools, "drive_get_metadata").handler({ account: "p", file_id: "f" });
  await find(tools, "drive_get_permissions").handler({ account: "p", file_id: "f" });
  await find(tools, "drive_move").handler({ account: "p", file_id: "f", parent_id: "new" });
  for (const c of calls) assert.equal(c.request.supportsAllDrives, true, `${c.method} lacks supportsAllDrives`);
});

test("there is no permanent-delete tool", () => {
  const all = [
    ...(createDriveTools(() => fake().client, names) as Tool[]),
    ...(createCommentTools(() => fake().client, names) as Tool[]),
  ];
  for (const t of all) assert.ok(!/delete_file|empty_trash|permanent/.test(t.name), t.name);
});

// ---------- Forms ----------

const noScopes = () => undefined;

test("forms_get returns the form, readOnly", async () => {
  const { client, calls } = fake({ "forms.get": { formId: "F", items: [{ itemId: "i1" }] } });
  const tool = find(createFormsTools(() => client, names, noScopes) as Tool[], "forms_get");
  assert.equal(tool.readOnly, true);
  assert.equal(json(await tool.handler({ account: "p", form_id: "F" })).items[0].itemId, "i1");
  assert.equal(calls[0].request.formId, "F");
});

test("forms_add_questions appends after the existing items by default", async () => {
  const { client, calls } = fake({ "forms.get": { items: [{}, {}, {}] } });
  const tool = find(createFormsTools(() => client, names, noScopes) as Tool[], "forms_add_questions");
  assert.equal(tool.readOnly, false);
  const out = json(await tool.handler({
    account: "p", form_id: "F",
    questions: [{ title: "Name", type: "short_text", required: true }, { title: "Pick", type: "dropdown", options: ["a", "b"] }],
  }));
  assert.deepEqual([out.added, out.startIndex, out.itemCount], [2, 3, 5]);
  const batch = calls.find((c) => c.method === "forms.batchUpdate")!;
  const requests = (batch.request.requestBody as { requests: Array<{ createItem: { location: { index: number }; item: { title: string } } }> }).requests;
  assert.deepEqual(requests.map((r) => r.createItem.location.index), [3, 4]);
  assert.equal(requests[0].createItem.item.title, "Name");
});

test("forms_add_questions honours position and rejects out-of-range", async () => {
  const { client, calls } = fake({ "forms.get": { items: [{}, {}] } });
  const tool = find(createFormsTools(() => client, names, noScopes) as Tool[], "forms_add_questions");
  await tool.handler({ account: "p", form_id: "F", position: 0, questions: [{ title: "Q", type: "paragraph" }] });
  const batch = calls.find((c) => c.method === "forms.batchUpdate")!;
  assert.equal((batch.request.requestBody as { requests: Array<{ createItem: { location: { index: number } } }> }).requests[0].createItem.location.index, 0);
  await assert.rejects(() => tool.handler({ account: "p", form_id: "F", position: 9, questions: [{ title: "Q", type: "paragraph" }] }), /position must be/);
  await assert.rejects(() => tool.handler({ account: "p", form_id: "F", questions: [] }), /at least one question/);
});

test("forms_batch_update passes raw requests and the form-in-response flag", async () => {
  const { client, calls } = fake();
  const tool = find(createFormsTools(() => client, names, noScopes) as Tool[], "forms_batch_update");
  assert.equal(tool.readOnly, false);
  const requests = [{ deleteItem: { location: { index: 1 } } }, { moveItem: { originalLocation: { index: 0 }, newLocation: { index: 2 } } }];
  await tool.handler({ account: "p", form_id: "F", requests, include_form_in_response: true });
  assert.deepEqual(calls[0].request, { formId: "F", requestBody: { requests, includeFormInResponse: true } });
  await assert.rejects(() => tool.handler({ account: "p", form_id: "F", requests: [] }), /at least one/);
});

test("forms_get_response keys the answers by question title", async () => {
  const { client, calls } = fake({
    "forms.get": { info: { title: "Survey" }, items: [{ title: "Your name", questionItem: { question: { questionId: "q1" } } }] },
    "forms.responses.get": { responseId: "R", lastSubmittedTime: "2026-01-01T00:00:00Z", answers: { q1: { textAnswers: { answers: [{ value: "Ada" }] } } } },
  });
  const tool = find(createFormsTools(() => client, names, noScopes) as Tool[], "forms_get_response");
  assert.equal(tool.readOnly, true);
  const out = json(await tool.handler({ account: "p", form_id: "F", response_id: "R" }));
  assert.equal(out.response.answers["Your name"], "Ada");
  assert.equal(calls.find((c) => c.method === "forms.responses.get")!.request.responseId, "R");
});

test("forms write tools refuse an account whose token lacks forms scopes", async () => {
  const { client } = fake();
  const tool = find(createFormsTools(() => client, names, () => ["https://www.googleapis.com/auth/gmail.readonly"]) as Tool[], "forms_batch_update");
  await assert.rejects(() => tool.handler({ account: "p", form_id: "F", requests: [{}] }), /Re-auth needed/);
});

// ---------- Sheets ----------

test("sheets_clear_range clears values", async () => {
  const { client, calls } = fake();
  const tool = find(createSheetsTools(() => client, names) as Tool[], "sheets_clear_range");
  await tool.handler({ account: "p", spreadsheet_id: "S", range: "Tab!A1:B2" });
  assert.equal(calls[0].method, "spreadsheets.values.clear");
  assert.equal(calls[0].request.range, "Tab!A1:B2");
});

test("sheets_create builds named tabs", async () => {
  const { client, calls } = fake({ "spreadsheets.create": { spreadsheetId: "S", spreadsheetUrl: "u", sheets: [{ properties: { sheetId: 0, title: "A" } }] } });
  const tool = find(createSheetsTools(() => client, names) as Tool[], "sheets_create");
  const out = json(await tool.handler({ account: "p", title: "Budget", tabs: ["A", " B "] }));
  assert.equal(out.spreadsheetId, "S");
  assert.deepEqual(calls[0].request.requestBody, {
    properties: { title: "Budget" },
    sheets: [{ properties: { title: "A" } }, { properties: { title: "B" } }],
  });
});

test("sheets_add_tab, rename and delete send the matching batchUpdate request", async () => {
  const { client, calls } = fake({ "spreadsheets.batchUpdate": { replies: [{ addSheet: { properties: { sheetId: 7, title: "New" } } }] } });
  const tools = createSheetsTools(() => client, names) as Tool[];
  const added = json(await find(tools, "sheets_add_tab").handler({ account: "p", spreadsheet_id: "S", title: "New", index: 1, rows: 10, columns: 3 }));
  assert.equal(added.sheet.sheetId, 7);
  assert.deepEqual(calls[0].request.requestBody, {
    requests: [{ addSheet: { properties: { title: "New", index: 1, gridProperties: { rowCount: 10, columnCount: 3 } } } }],
  });
  await find(tools, "sheets_rename_tab").handler({ account: "p", spreadsheet_id: "S", sheet_id: 7, title: "Renamed" });
  assert.deepEqual(calls[1].request.requestBody, {
    requests: [{ updateSheetProperties: { properties: { sheetId: 7, title: "Renamed" }, fields: "title" } }],
  });
  const del = find(tools, "sheets_delete_tab");
  assert.match((del as unknown as { description: string }).description, /DESTRUCTIVE/);
  await del.handler({ account: "p", spreadsheet_id: "S", sheet_id: 7 });
  assert.deepEqual(calls[2].request.requestBody, { requests: [{ deleteSheet: { sheetId: 7 } }] });
  await assert.rejects(() => find(tools, "sheets_add_tab").handler({ account: "p", spreadsheet_id: "S", title: " " }), /title is required/);
});

test("sheets_find returns A1 addresses offset by the range start", async () => {
  const { client } = fake({
    "spreadsheets.values.get": { range: "Tab!B3:D5", values: [["x", "Apple", ""], ["", "", "pineapple"], ["APPLE"]] },
  });
  const tool = find(createSheetsTools(() => client, names) as Tool[], "sheets_find");
  assert.equal(tool.readOnly, true);
  const loose = json(await tool.handler({ account: "p", spreadsheet_id: "S", range: "Tab", query: "apple" }));
  assert.deepEqual(loose.matches.map((m: { cell: string }) => m.cell), ["C3", "D4", "B5"]);
  const exact = json(await tool.handler({ account: "p", spreadsheet_id: "S", range: "Tab", query: "apple", exact: true, match_case: true }));
  assert.equal(exact.count, 0);
  const capped = json(await tool.handler({ account: "p", spreadsheet_id: "S", range: "Tab", query: "apple", max_results: 1 }));
  assert.equal(capped.count, 1);
});

test("A1 helpers", () => {
  assert.equal(columnName(0), "A");
  assert.equal(columnName(25), "Z");
  assert.equal(columnName(26), "AA");
  assert.deepEqual(parseStartCell("'My Tab'!AA10:AB12"), { col: 26, row: 10 });
  assert.deepEqual(parseStartCell("Sheet1"), { col: 0, row: 1 });
  assert.deepEqual(parseStartCell("Sheet1!A:C"), { col: 0, row: 1 });
});

// ---------- Slides ----------

const deck = {
  presentationId: "P",
  title: "Deck",
  slides: [
    {
      objectId: "s1",
      pageElements: [
        { objectId: "t1", shape: { text: { textElements: [{ textRun: { content: "Hello\n" } }] } } },
        { objectId: "tbl", table: { tableRows: [{ tableCells: [{ text: { textElements: [{ textRun: { content: "a\n" } }] } }, { text: { textElements: [{ textRun: { content: "b\n" } }] } }] }] } },
      ],
      slideProperties: {
        notesPage: {
          notesProperties: { speakerNotesObjectId: "notes1" },
          pageElements: [{ objectId: "notes1", shape: { text: { textElements: [{ textRun: { content: "old notes\n" } }] } } }],
        },
      },
    },
    { objectId: "s2", pageElements: [], slideProperties: { notesPage: { notesProperties: { speakerNotesObjectId: "notes2" }, pageElements: [{ objectId: "notes2" }] } } },
  ],
};

test("slides_read_text includes tables and speaker notes", async () => {
  const { client } = fake({ "presentations.get": deck });
  const tool = find(createSlidesTools(() => client, names) as Tool[], "slides_read_text");
  assert.equal(tool.readOnly, true);
  const out = json(await tool.handler({ account: "p", presentation_id: "P" }));
  assert.deepEqual(out.slides[0].elements, [
    { objectId: "t1", kind: "shape", text: "Hello" },
    { objectId: "tbl", kind: "table-row", text: "a | b" },
  ]);
  assert.equal(out.slides[0].speakerNotes, "old notes");
  assert.equal(out.slides[1].speakerNotes, "");
  assert.equal(readPresentationText(deck as never).length, 2);
});

test("slides_get_thumbnail asks for a PNG at the requested size", async () => {
  const { client, calls } = fake({ "presentations.pages.getThumbnail": { contentUrl: "https://img/x", width: 1600, height: 900 } });
  const tool = find(createSlidesTools(() => client, names) as Tool[], "slides_get_thumbnail");
  assert.equal(tool.readOnly, true);
  const out = json(await tool.handler({ account: "p", presentation_id: "P", slide_id: "s1", size: "medium" }));
  assert.equal(out.contentUrl, "https://img/x");
  assert.deepEqual(calls[0].request, {
    presentationId: "P", pageObjectId: "s1", "thumbnailProperties.mimeType": "PNG", "thumbnailProperties.thumbnailSize": "MEDIUM",
  });
  await assert.rejects(() => tool.handler({ account: "p", presentation_id: "P", slide_id: "s1", size: "HUGE" }), /size must be/);
});

test("slides_save_thumbnail downloads the PNG to disk", async () => {
  const { client } = fake({ "presentations.pages.getThumbnail": { contentUrl: "https://img/x" } });
  const tool = find(createSlidesTools(() => client, names) as Tool[], "slides_save_thumbnail");
  assert.equal(tool.readOnly, false);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    assert.equal(url, "https://img/x");
    return new Response(Buffer.from([1, 2, 3, 4]), { status: 200 });
  }) as typeof fetch;
  try {
    const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "thumb-")), "sub", "s.png");
    const out = json(await tool.handler({ account: "p", presentation_id: "P", slide_id: "s1", destination_path: dest }));
    assert.equal(out.byteCount, 4);
    assert.deepEqual([...fs.readFileSync(dest)], [1, 2, 3, 4]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("slides delete, duplicate and reorder send the matching requests", async () => {
  const { client, calls } = fake({ "presentations.batchUpdate": { replies: [{ duplicateObject: { objectId: "copy1" } }] } });
  const tools = createSlidesTools(() => client, names) as Tool[];
  const del = find(tools, "slides_delete_slide");
  assert.match((del as unknown as { description: string }).description, /DESTRUCTIVE/);
  await del.handler({ account: "p", presentation_id: "P", slide_id: "s1" });
  assert.deepEqual(calls[0].request.requestBody, { requests: [{ deleteObject: { objectId: "s1" } }] });
  const dup = json(await find(tools, "slides_duplicate_slide").handler({ account: "p", presentation_id: "P", slide_id: "s1" }));
  assert.equal(dup.newSlideId, "copy1");
  assert.deepEqual(calls[1].request.requestBody, { requests: [{ duplicateObject: { objectId: "s1" } }] });
  await find(tools, "slides_reorder_slides").handler({ account: "p", presentation_id: "P", slide_ids: ["s2", "s1"], insertion_index: 0 });
  assert.deepEqual(calls[2].request.requestBody, { requests: [{ updateSlidesPosition: { slideObjectIds: ["s2", "s1"], insertionIndex: 0 } }] });
  await assert.rejects(() => find(tools, "slides_reorder_slides").handler({ account: "p", presentation_id: "P", slide_ids: [], insertion_index: 0 }), /at least one slide/);
  await assert.rejects(() => find(tools, "slides_reorder_slides").handler({ account: "p", presentation_id: "P", slide_ids: ["s1"], insertion_index: -1 }), /non-negative/);
});

test("slides_insert_image builds a createImage request with optional geometry", async () => {
  const { client, calls } = fake({ "presentations.batchUpdate": { replies: [{ createImage: { objectId: "img1" } }] } });
  const tool = find(createSlidesTools(() => client, names) as Tool[], "slides_insert_image");
  const out = json(await tool.handler({ account: "p", presentation_id: "P", slide_id: "s1", url: "https://x/y.png", x: 10, y: 20, width: 100, height: 50 }));
  assert.equal(out.imageObjectId, "img1");
  assert.deepEqual(calls[0].request.requestBody, {
    requests: [{
      createImage: {
        url: "https://x/y.png",
        elementProperties: {
          pageObjectId: "s1",
          size: { width: { magnitude: 100, unit: "PT" }, height: { magnitude: 50, unit: "PT" } },
          transform: { scaleX: 1, scaleY: 1, translateX: 10, translateY: 20, unit: "PT" },
        },
      },
    }],
  });
  await tool.handler({ account: "p", presentation_id: "P", slide_id: "s1", url: "https://x/y.png" });
  assert.deepEqual((calls[1].request.requestBody as { requests: Array<{ createImage: { elementProperties: unknown } }> }).requests[0].createImage.elementProperties, { pageObjectId: "s1" });
  await assert.rejects(() => tool.handler({ account: "p", presentation_id: "P", slide_id: "s1", url: "ftp://x" }), /http\(s\)/);
  await assert.rejects(() => tool.handler({ account: "p", presentation_id: "P", slide_id: "s1", url: "https://x", width: 5 }), /both width and height/);
});

test("slides_set_speaker_notes deletes old notes before inserting, and skips delete when empty", async () => {
  const { client, calls } = fake({ "presentations.get": deck });
  const tool = find(createSlidesTools(() => client, names) as Tool[], "slides_set_speaker_notes");
  await tool.handler({ account: "p", presentation_id: "P", slide_id: "s1", notes: "new" });
  assert.deepEqual(calls.find((c) => c.method === "presentations.batchUpdate")!.request.requestBody, {
    requests: [
      { deleteText: { objectId: "notes1", textRange: { type: "ALL" } } },
      { insertText: { objectId: "notes1", insertionIndex: 0, text: "new" } },
    ],
  });
  calls.length = 0;
  await tool.handler({ account: "p", presentation_id: "P", slide_id: "s2", notes: "first" });
  assert.deepEqual(calls.find((c) => c.method === "presentations.batchUpdate")!.request.requestBody, {
    requests: [{ insertText: { objectId: "notes2", insertionIndex: 0, text: "first" } }],
  });
  calls.length = 0;
  const noop = json(await tool.handler({ account: "p", presentation_id: "P", slide_id: "s2", notes: "" }));
  assert.equal(noop.changed, false);
  assert.ok(!calls.some((c) => c.method === "presentations.batchUpdate"));
  await assert.rejects(() => tool.handler({ account: "p", presentation_id: "P", slide_id: "nope", notes: "x" }), /no slide/);
});

// ---------- Comments ----------

test("docs_reopen_comment replies with action=reopen", async () => {
  const { client, calls } = fake({ "replies.create": { id: "r" } });
  const tool = find(createCommentTools(() => client, names) as Tool[], "docs_reopen_comment");
  assert.equal(tool.readOnly, false);
  const out = json(await tool.handler({ account: "p", file_id: "f", comment_id: "c", content: "back" }));
  assert.equal(out.action, "reopen");
  assert.equal(calls[0].method, "replies.create");
  assert.deepEqual(calls[0].request.requestBody, { action: "reopen", content: "back" });
});

test("docs_delete_comment deletes the comment and says it is destructive", async () => {
  const { client, calls } = fake();
  const tool = find(createCommentTools(() => client, names) as Tool[], "docs_delete_comment");
  assert.equal(tool.readOnly, false);
  assert.match((tool as unknown as { description: string }).description, /Destructive/);
  const out = json(await tool.handler({ account: "p", file_id: "f", comment_id: "c" }));
  assert.equal(out.deleted, true);
  assert.deepEqual(calls[0], { method: "comments.delete", request: { fileId: "f", commentId: "c" } });
});

test("docs_list_comments already returns replies, anchor and quoted text", async () => {
  const { client, calls } = fake({ "comments.list": { comments: [{ id: "c1", resolved: false }] } });
  const tool = find(createCommentTools(() => client, names) as Tool[], "docs_list_comments");
  await tool.handler({ account: "p", file_id: "f" });
  const fields = String(calls[0].request.fields);
  for (const part of ["replies(", "anchor", "quotedFileContent"]) assert.ok(fields.includes(part), part);
});
