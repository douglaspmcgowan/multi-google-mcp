import assert from "node:assert/strict";
import test from "node:test";
import { SCOPES } from "../dist/config.js";
import { buildQuestionRequests, createFormsTools, QUESTION_TYPES } from "../dist/tools/forms.js";

type Tool = {
  name: string;
  readOnly: boolean;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
};

function handler(tools: readonly Tool[], name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.handler;
}

const json = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);
const A = "https://www.googleapis.com/auth/";
const newToken = () => SCOPES;

type Call = { method: string; req: any };

/** A fake Forms client that records every call and answers with `data`. */
function fakeForms(calls: Call[], data: Record<string, unknown> = {}) {
  const rec = (method: string, out: unknown = data) => async (req: any) => {
    calls.push({ method, req });
    return { data: out };
  };
  return () =>
    ({
      forms: {
        get: rec("get", data),
        create: rec("create", { formId: "F1", responderUri: "https://docs.google.com/forms/d/e/x/viewform" }),
        batchUpdate: rec("batchUpdate", { replies: [{}] }),
        setPublishSettings: rec("setPublishSettings", { formId: "F1" }),
        responses: { list: rec("responses.list", { responses: [] }), get: rec("responses.get", {}) },
        watches: {
          create: rec("watches.create", { id: "w1", state: "ACTIVE" }),
          list: rec("watches.list", { watches: [{ id: "w1" }] }),
          delete: rec("watches.delete", {}),
          renew: rec("watches.renew", { id: "w1" }),
        },
      },
    }) as never;
}

test("every Forms tool is registered once, with an explicit readOnly flag", () => {
  const tools = createFormsTools(() => ({}) as never, () => [], newToken, () => ({}) as never) as Tool[];
  const names = tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const expected of [
    "forms_set_publish_settings", "forms_responder_url", "forms_list", "forms_update_info", "forms_update_settings",
    "forms_update_item", "forms_move_item", "forms_delete_item", "forms_watch_create", "forms_watch_list",
    "forms_watch_renew", "forms_watch_delete",
  ]) {
    assert.ok(names.includes(expected), `${expected} missing`);
  }
  for (const reader of ["forms_responder_url", "forms_list", "forms_watch_list"]) {
    assert.equal(tools.find((t) => t.name === reader)!.readOnly, true, reader);
  }
});

test("question builder covers the added item kinds with the exact request shapes", () => {
  const reqs = buildQuestionRequests([
    { title: "Pick", type: "multiple_choice", options: ["a"], other: true, shuffle: true },
    { title: "When", type: "date", include_time: true, include_year: false },
    { title: "Elapsed", type: "time", duration: true },
    { title: "Stars", type: "rating", rating_levels: 7, icon: "heart" },
    { title: "Rows", type: "grid", rows: ["r1", "r2"], columns: ["Bad", "Good"], column_type: "checkbox", required: true, shuffle_rows: true },
    { type: "text", title: "Read this", description: "Block of text" },
    { type: "page_break", title: "Part two" },
    { type: "image", source_uri: "https://example.com/i.png", alt_text: "logo" },
    { type: "video", youtube_uri: "https://www.youtube.com/watch?v=abc", caption: "Intro" },
  ]) as any[];
  const item = (i: number) => reqs[i].createItem.item;
  assert.deepEqual(item(0).questionItem.question.choiceQuestion, {
    type: "RADIO",
    options: [{ value: "a" }, { isOther: true }],
    shuffle: true,
  });
  assert.deepEqual(item(1).questionItem.question.dateQuestion, { includeYear: false, includeTime: true });
  assert.deepEqual(item(2).questionItem.question.timeQuestion, { duration: true });
  assert.deepEqual(item(3).questionItem.question.ratingQuestion, { ratingScaleLevel: 7, iconType: "HEART" });
  assert.deepEqual(item(4).questionGroupItem, {
    questions: [
      { required: true, rowQuestion: { title: "r1" } },
      { required: true, rowQuestion: { title: "r2" } },
    ],
    grid: {
      columns: { type: "CHECKBOX", options: [{ value: "Bad" }, { value: "Good" }] },
      shuffleQuestions: true,
    },
  });
  assert.deepEqual(item(5), { title: "Read this", description: "Block of text", textItem: {} });
  assert.deepEqual(item(6), { title: "Part two", pageBreakItem: {} });
  assert.deepEqual(item(7), { imageItem: { image: { sourceUri: "https://example.com/i.png", altText: "logo" } } });
  assert.deepEqual(item(8), { videoItem: { video: { youtubeUri: "https://www.youtube.com/watch?v=abc" }, caption: "Intro" } });
  assert.deepEqual(reqs[8].createItem.location, { index: 8 });
  assert.ok(QUESTION_TYPES.includes("grid") && QUESTION_TYPES.includes("page_break"));
});

test("question builder rejects what the API cannot create or is missing", () => {
  assert.throws(() => buildQuestionRequests([{ title: "Up", type: "file_upload" }]), /cannot be created through the Forms API/);
  assert.throws(() => buildQuestionRequests([{ title: "G", type: "grid", rows: ["r"] }]), /needs rows and columns/);
  assert.throws(() => buildQuestionRequests([{ title: "I", type: "image" }]), /needs source_uri/);
  assert.throws(() => buildQuestionRequests([{ title: "V", type: "video" }]), /needs youtube_uri/);
  assert.throws(() => buildQuestionRequests([{ title: "R", type: "rating", icon: "SMILE" }]), /rating icon/);
  assert.throws(() => buildQuestionRequests([{ type: "short_text" }]), /has no title/);
});

test("forms_set_publish_settings sends publishState with its mask", async () => {
  const calls: Call[] = [];
  const tools = createFormsTools(fakeForms(calls), () => [], newToken, () => ({}) as never) as Tool[];
  await handler(tools, "forms_set_publish_settings")({ account: "b", form_id: "F1", published: true });
  assert.deepEqual(calls[0], {
    method: "setPublishSettings",
    req: {
      formId: "F1",
      requestBody: {
        publishSettings: { publishState: { isPublished: true, isAcceptingResponses: true } },
        updateMask: "publishState",
      },
    },
  });
  await handler(tools, "forms_set_publish_settings")({ account: "b", form_id: "F1", published: true, accepting_responses: false });
  assert.deepEqual(calls[1].req.requestBody.publishSettings.publishState, { isPublished: true, isAcceptingResponses: false });
  await assert.rejects(
    handler(tools, "forms_set_publish_settings")({ account: "b", form_id: "F1", published: false, accepting_responses: true }),
    /cannot accept responses/
  );
  assert.equal(calls.length, 2);
});

test("forms_create says when a form is left unpublished", async () => {
  const calls: Call[] = [];
  const tools = createFormsTools(fakeForms(calls), () => [], newToken, () => ({}) as never) as Tool[];
  const out = json(await handler(tools, "forms_create")({ account: "b", title: "Draft", publish: false }));
  assert.equal(out.published, false);
  assert.match(out.note, /Created unpublished/);
});

test("forms_responder_url summarises the publish state and responder link", async () => {
  const calls: Call[] = [];
  const form = {
    formId: "F1",
    info: { title: "Survey" },
    responderUri: "https://docs.google.com/forms/d/e/x/viewform",
    publishSettings: { publishState: { isPublished: true, isAcceptingResponses: true } },
  };
  const tools = createFormsTools(fakeForms(calls, form), () => [], newToken, () => ({}) as never) as Tool[];
  const out = json(await handler(tools, "forms_responder_url")({ account: "b", form_id: "F1" }));
  assert.equal(out.responderUri, "https://docs.google.com/forms/d/e/x/viewform");
  assert.equal(out.summary, '"Survey" is published, accepting responses: https://docs.google.com/forms/d/e/x/viewform');
  assert.equal(calls[0].req.formId, "F1");
});

test("forms_list asks Drive for form files only", async () => {
  const drive: any[] = [];
  const tools = createFormsTools(
    fakeForms([]),
    () => [],
    newToken,
    () =>
      ({
        files: {
          list: async (req: any) => {
            drive.push(req);
            return { data: { files: [{ id: "F1", name: "Survey" }] } };
          },
        },
      }) as never
  ) as Tool[];
  const out = json(await handler(tools, "forms_list")({ account: "b", max_results: 5 }));
  assert.deepEqual(drive[0], {
    q: "mimeType = 'application/vnd.google-apps.form' and trashed = false",
    fields: "files(id,name,modifiedTime,webViewLink)",
    orderBy: "modifiedTime desc",
    pageSize: 5,
  });
  assert.deepEqual(out, { count: 1, forms: [{ id: "F1", name: "Survey" }] });
});

test("forms_update_info sends only the given fields in updateFormInfo", async () => {
  const calls: Call[] = [];
  const tools = createFormsTools(fakeForms(calls), () => [], newToken, () => ({}) as never) as Tool[];
  await handler(tools, "forms_update_info")({ account: "b", form_id: "F1", title: "New" });
  assert.deepEqual(calls[0].req, {
    formId: "F1",
    requestBody: { requests: [{ updateFormInfo: { info: { title: "New" }, updateMask: "title" } }] },
  });
  await handler(tools, "forms_update_info")({ account: "b", form_id: "F1", title: "", description: "Desc" });
  assert.deepEqual(calls[1].req.requestBody.requests[0], {
    updateFormInfo: { info: { title: "", description: "Desc" }, updateMask: "title,description" },
  });
  await assert.rejects(handler(tools, "forms_update_info")({ account: "b", form_id: "F1" }), /pass title, description or both/);
});

test("forms_update_settings sends quiz and email collection with their masks", async () => {
  const calls: Call[] = [];
  const tools = createFormsTools(fakeForms(calls), () => [], newToken, () => ({}) as never) as Tool[];
  await handler(tools, "forms_update_settings")({ account: "b", form_id: "F1", quiz_mode: true, email_collection: "VERIFIED" });
  assert.deepEqual(calls[0].req.requestBody.requests[0], {
    updateSettings: {
      settings: { quizSettings: { isQuiz: true }, emailCollectionType: "VERIFIED" },
      updateMask: "quizSettings.isQuiz,emailCollectionType",
    },
  });
  await assert.rejects(
    handler(tools, "forms_update_settings")({ account: "b", form_id: "F1", email_collection: "EVERYONE" }),
    /email_collection must be one of/
  );
  await assert.rejects(handler(tools, "forms_update_settings")({ account: "b", form_id: "F1" }), /pass quiz_mode/);
});

test("forms_update_item, forms_move_item and forms_delete_item send the exact request", async () => {
  const calls: Call[] = [];
  const tools = createFormsTools(fakeForms(calls), () => [], newToken, () => ({}) as never) as Tool[];
  const item = { title: "Renamed", questionItem: { question: { required: false, textQuestion: { paragraph: true } } } };
  await handler(tools, "forms_update_item")({ account: "b", form_id: "F1", index: 2, item, update_mask: "title,questionItem.question.textQuestion" });
  assert.deepEqual(calls[0].req.requestBody.requests[0], {
    updateItem: { item, location: { index: 2 }, updateMask: "title,questionItem.question.textQuestion" },
  });
  await assert.rejects(handler(tools, "forms_update_item")({ account: "b", form_id: "F1", index: 2, item, update_mask: " " }), /update_mask/);

  await handler(tools, "forms_move_item")({ account: "b", form_id: "F1", from_index: 3, to_index: 0 });
  assert.deepEqual(calls[1].req.requestBody.requests[0], {
    moveItem: { originalLocation: { index: 3 }, newLocation: { index: 0 } },
  });
  await assert.rejects(handler(tools, "forms_move_item")({ account: "b", form_id: "F1", from_index: -1, to_index: 0 }), /non-negative/);

  await handler(tools, "forms_delete_item")({ account: "b", form_id: "F1", index: 4 });
  assert.deepEqual(calls[2].req.requestBody.requests[0], { deleteItem: { location: { index: 4 } } });
  assert.equal(calls.length, 3);
});

test("forms_watch_create sends a SCHEMA or RESPONSES watch on a full Pub/Sub topic name", async () => {
  const calls: Call[] = [];
  const tools = createFormsTools(fakeForms(calls), () => [], newToken, () => ({}) as never) as Tool[];
  await handler(tools, "forms_watch_create")({
    account: "b",
    form_id: "F1",
    topic_name: "projects/my-proj/topics/forms",
    event_type: "RESPONSES",
    watch_id: "resp-watch",
  });
  assert.deepEqual(calls[0].req, {
    formId: "F1",
    requestBody: {
      watch: { eventType: "RESPONSES", target: { topic: { topicName: "projects/my-proj/topics/forms" } } },
      watchId: "resp-watch",
    },
  });
  await assert.rejects(
    handler(tools, "forms_watch_create")({ account: "b", form_id: "F1", topic_name: "forms", event_type: "SCHEMA" }),
    /projects\/<project>\/topics/
  );
  await assert.rejects(
    handler(tools, "forms_watch_create")({ account: "b", form_id: "F1", topic_name: "projects/p/topics/t", event_type: "ALL" }),
    /SCHEMA or RESPONSES/
  );
  assert.equal(calls.length, 1);
});

test("forms_watch_list, forms_watch_renew and forms_watch_delete address the watch by id", async () => {
  const calls: Call[] = [];
  const tools = createFormsTools(fakeForms(calls), () => [], newToken, () => ({}) as never) as Tool[];
  const listed = json(await handler(tools, "forms_watch_list")({ account: "b", form_id: "F1" }));
  assert.deepEqual(listed.watches, [{ id: "w1" }]);
  assert.deepEqual(calls[0], { method: "watches.list", req: { formId: "F1" } });
  await handler(tools, "forms_watch_renew")({ account: "b", form_id: "F1", watch_id: "w1" });
  assert.deepEqual(calls[1], { method: "watches.renew", req: { formId: "F1", watchId: "w1" } });
  await handler(tools, "forms_watch_delete")({ account: "b", form_id: "F1", watch_id: "w1" });
  assert.deepEqual(calls[2], { method: "watches.delete", req: { formId: "F1", watchId: "w1" } });
});

test("forms_add_questions accepts the new item kinds through the shared builder", async () => {
  const calls: Call[] = [];
  const tools = createFormsTools(fakeForms(calls, { items: [{}, {}] }), () => [], newToken, () => ({}) as never) as Tool[];
  const out = json(
    await handler(tools, "forms_add_questions")({
      account: "b",
      form_id: "F1",
      questions: [{ type: "page_break", title: "Next" }, { title: "Rate", type: "rating" }],
    })
  );
  assert.equal(out.startIndex, 2);
  assert.equal(out.itemCount, 4);
  const requests = calls.find((c) => c.method === "batchUpdate")!.req.requestBody.requests;
  assert.deepEqual(requests[0].createItem.location, { index: 2 });
  assert.deepEqual(requests[1].createItem.item.questionItem.question.ratingQuestion, { ratingScaleLevel: 5, iconType: "STAR" });
});
