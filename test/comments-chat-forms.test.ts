import assert from "node:assert/strict";
import test from "node:test";
import { SCOPES } from "../dist/config.js";
import { ScopeError, reauthCommand, requireScope, translateScopeError } from "../dist/scopes.js";
import { createCommentTools } from "../dist/tools/comments.js";
import { createChatTools, spaceName } from "../dist/tools/chat.js";
import { buildQuestionRequests, createFormsTools, flattenResponses } from "../dist/tools/forms.js";
import { createDriveTools } from "../dist/tools/drive.js";

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
const A = "https://www.googleapis.com/auth/";
const oldToken = () => [`${A}drive`, `${A}gmail.modify`];
const newToken = () => SCOPES;

test("SCOPES adds the Chat and Forms scopes", () => {
  for (const s of ["chat.spaces", "chat.messages", "chat.memberships", "forms.body", "forms.responses.readonly"]) {
    assert.ok(SCOPES.includes(`${A}${s}`), s);
  }
});

test("a token without the scope fails with the exact re-auth command, not a crash", () => {
  assert.throws(
    () => requireScope("berkeley", [`${A}chat.spaces`], oldToken),
    (error: Error) =>
      error instanceof ScopeError &&
      error.message.includes("chat.spaces") &&
      error.message.includes('npm run add-account -- --account berkeley')
  );
  assert.doesNotThrow(() => requireScope("berkeley", [`${A}chat.spaces`], newToken));
  assert.doesNotThrow(() => requireScope("x", [`${A}chat.spaces`], () => undefined), "unknown scope list defers to Google");
  const translated = translateScopeError(new Error("Request had insufficient authentication scopes."), "work", [`${A}chat.messages`]);
  assert.ok(translated instanceof ScopeError);
  assert.equal(reauthCommand("work"), 'cd "$env:USERPROFILE\\multi-google-mcp"; npm run add-account -- --account work');
});

test("comment tools send fields masks and use replies action=resolve", async () => {
  const calls: Array<{ method: string; req: any }> = [];
  const rec = (method: string, data: unknown) => async (req: any) => {
    calls.push({ method, req });
    return { data };
  };
  const tools = createCommentTools(
    () =>
      ({
        comments: {
          list: rec("list", {
            comments: [
              { id: "c1", content: "open", resolved: false },
              { id: "c2", content: "done", resolved: true },
            ],
          }),
          create: rec("create", { id: "c3" }),
        },
        replies: { create: rec("reply", { id: "r1" }) },
      }) as never,
    () => []
  );
  const listed = json(await handler(tools, "docs_list_comments")({ account: "b", file_id: "f" }));
  assert.deepEqual(listed.comments.map((c: any) => c.id), ["c1"]);
  assert.match(calls[0].req.fields, /^nextPageToken,comments\(id,content,.*replies\(/);
  const all = json(await handler(tools, "docs_list_comments")({ account: "b", file_id: "f", include_resolved: true }));
  assert.equal(all.count, 2);

  await handler(tools, "docs_add_comment")({ account: "b", file_id: "f", content: "hi", quoted_text: "passage" });
  const create = calls.find((c) => c.method === "create")!.req;
  assert.deepEqual(create.requestBody, { content: "hi", quotedFileContent: { mimeType: "text/plain", value: "passage" } });
  assert.ok(create.fields);

  await handler(tools, "docs_reply_comment")({ account: "b", file_id: "f", comment_id: "c1", content: "ok" });
  await handler(tools, "docs_resolve_comment")({ account: "b", file_id: "f", comment_id: "c1" });
  await handler(tools, "docs_resolve_comment")({ account: "b", file_id: "f", comment_id: "c1", reopen: true, content: "again" });
  const replies = calls.filter((c) => c.method === "reply").map((c) => c.req.requestBody);
  assert.deepEqual(replies, [{ content: "ok" }, { action: "resolve" }, { action: "reopen", content: "again" }]);
});

function chatClient(calls: Array<{ method: string; req: any }>, failFor = "") {
  const rec = (method: string, data: unknown) => async (req: any) => {
    calls.push({ method, req });
    if (failFor && JSON.stringify(req).includes(failFor)) throw new Error("User not found");
    return { data };
  };
  return () =>
    ({
      spaces: {
        list: rec("spaces.list", { spaces: [{ name: "spaces/A", displayName: "Team", spaceType: "SPACE", extra: 1 }] }),
        messages: { create: rec("messages.create", { name: "spaces/A/messages/1", thread: { name: "spaces/A/threads/t" } }) },
        members: {
          list: rec("members.list", { memberships: [{ name: "spaces/A/members/1", role: "ROLE_MEMBER", member: { name: "users/1", type: "HUMAN" } }] }),
          create: rec("members.create", { name: "spaces/A/members/2", state: "JOINED" }),
        },
      },
    }) as never;
}

test("chat tools refuse old tokens before calling Google", async () => {
  const calls: any[] = [];
  const tools = createChatTools(chatClient(calls), () => [], oldToken);
  for (const [name, args] of [
    ["chat_list_spaces", {}],
    ["chat_post_message", { space: "A", text: "hi" }],
    ["chat_list_members", { space: "A" }],
    ["chat_add_members", { space: "A", email: "x@y.z" }],
  ] as const) {
    await assert.rejects(handler(tools, name)({ account: "berkeley", ...args }), /Re-auth needed.*--account berkeley/);
  }
  assert.equal(calls.length, 0);
});

test("chat tools call the verified methods with space and user resource names", async () => {
  const calls: Array<{ method: string; req: any }> = [];
  const tools = createChatTools(chatClient(calls, "bad@x.y"), () => [], newToken);
  const spaces = json(await handler(tools, "chat_list_spaces")({ account: "b", filter: 'spaceType = "SPACE"' }));
  assert.deepEqual(spaces, [{ name: "spaces/A", displayName: "Team", spaceType: "SPACE" }]);
  assert.equal(calls[0].req.filter, 'spaceType = "SPACE"');

  await handler(tools, "chat_post_message")({ account: "b", space: "A", text: "hi", thread_key: "k1" });
  assert.deepEqual(calls[1].req, {
    parent: "spaces/A",
    requestBody: { text: "hi", thread: { threadKey: "k1" } },
    messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
  });

  await handler(tools, "chat_list_members")({ account: "b", space: "spaces/A", show_invited: true });
  assert.equal(calls[2].req.showInvited, true);

  const added = json(
    await handler(tools, "chat_add_members")({ account: "b", space: "A", email: "a@x.y", emails: ["A@x.y", "bad@x.y", "c@x.y"] })
  );
  assert.equal(added.added, 2);
  assert.equal(added.failed, 1);
  assert.deepEqual(
    calls.filter((c) => c.method === "members.create").map((c) => c.req.requestBody.member),
    [
      { name: "users/a@x.y", type: "HUMAN" },
      { name: "users/bad@x.y", type: "HUMAN" },
      { name: "users/c@x.y", type: "HUMAN" },
    ]
  );
  assert.equal(spaceName("https://mail.google.com/chat/u/0/#chat/space/AAAA123"), "spaces/AAAA123");
});

test("forms question builder covers every type and rejects bad input", () => {
  const reqs = buildQuestionRequests([
    { title: "Name", type: "short_text", required: true },
    { title: "Why", type: "paragraph" },
    { title: "Pick", type: "multiple_choice", options: ["a", "b"] },
    { title: "Many", type: "checkboxes", options: ["x"] },
    { title: "Drop", type: "dropdown", options: ["y"] },
    { title: "Rate", type: "scale", low: 1, high: 5, low_label: "bad" },
    { title: "When", type: "date" },
    { title: "Time", type: "time" },
  ]) as any[];
  const q = (i: number) => reqs[i].createItem.item.questionItem.question;
  assert.deepEqual(q(0), { required: true, textQuestion: { paragraph: false } });
  assert.deepEqual(q(2).choiceQuestion, { type: "RADIO", options: [{ value: "a" }, { value: "b" }] });
  assert.equal(q(3).choiceQuestion.type, "CHECKBOX");
  assert.equal(q(4).choiceQuestion.type, "DROP_DOWN");
  assert.deepEqual(q(5).scaleQuestion, { low: 1, high: 5, lowLabel: "bad" });
  assert.ok(q(6).dateQuestion && q(7).timeQuestion);
  assert.deepEqual(reqs[7].createItem.location, { index: 7 });
  assert.throws(() => buildQuestionRequests([{ title: "P", type: "dropdown" }]), /needs options/);
  assert.throws(() => buildQuestionRequests([{ title: "P", type: "essay" }]), /unknown type/);
});

test("forms_create creates, batch-adds questions, then publishes", async () => {
  const calls: Array<{ method: string; req: any }> = [];
  const rec = (method: string, data: unknown) => async (req: any) => {
    calls.push({ method, req });
    return { data };
  };
  const client = () =>
    ({
      forms: {
        create: rec("create", { formId: "F1", responderUri: "https://docs.google.com/forms/d/e/x/viewform" }),
        batchUpdate: rec("batchUpdate", {}),
        setPublishSettings: rec("publish", {}),
      },
    }) as never;
  const tools = createFormsTools(client, () => [], oldToken);
  const out = json(
    await handler(tools, "forms_create")({
      account: "b",
      title: "Survey",
      description: "About",
      questions: [{ title: "Name", type: "short_text" }],
    })
  );
  assert.deepEqual(calls.map((c) => c.method), ["create", "batchUpdate", "publish"]);
  assert.deepEqual(calls[0].req, { unpublished: false, requestBody: { info: { title: "Survey", documentTitle: "Survey" } } });
  assert.deepEqual(calls[1].req.requestBody.requests[0], { updateFormInfo: { info: { description: "About" }, updateMask: "description" } });
  assert.deepEqual(calls[2].req.requestBody.publishSettings.publishState, { isPublished: true, isAcceptingResponses: true });
  assert.equal(out.editUrl, "https://docs.google.com/forms/d/F1/edit");

  calls.length = 0;
  await handler(tools, "forms_create")({ account: "b", title: "Draft", publish: false });
  assert.deepEqual(calls.map((c) => c.method), ["create"]);
  assert.equal(calls[0].req.unpublished, true);

  const noDrive = createFormsTools(client, () => [], () => [`${A}gmail.modify`]);
  await assert.rejects(handler(noDrive, "forms_create")({ account: "b", title: "x" }), /Re-auth needed/);
});

test("forms_list_responses keys answers by question title and passes the since filter", async () => {
  const form = {
    info: { title: "Survey" },
    items: [
      { title: "Name", questionItem: { question: { questionId: "q1" } } },
      { title: "Pick", questionItem: { question: { questionId: "q2" } } },
    ],
  };
  const responses = [
    { responseId: "r2", lastSubmittedTime: "2026-09-22T10:00:00Z", answers: { q1: { textAnswers: { answers: [{ value: "Bo" }] } } } },
    {
      responseId: "r1",
      lastSubmittedTime: "2026-09-21T10:00:00Z",
      answers: { q2: { textAnswers: { answers: [{ value: "a" }, { value: "b" }] } } },
    },
  ];
  assert.deepEqual(flattenResponses(form as never, responses as never)[0].answers, { Name: "Bo" });
  const lists: any[] = [];
  const tools = createFormsTools(
    () =>
      ({
        forms: {
          get: async () => ({ data: form }),
          responses: {
            list: async (req: any) => {
              lists.push(req);
              return { data: { responses } };
            },
          },
        },
      }) as never,
    () => [],
    newToken
  );
  const out = json(await handler(tools, "forms_list_responses")({ account: "b", form_id: "F1", since: "2026-09-20" }));
  assert.equal(lists[0].filter, "timestamp > 2026-09-20T00:00:00.000Z");
  assert.deepEqual(out.responses.map((r: any) => r.responseId), ["r1", "r2"]);
  assert.deepEqual(out.responses[0].answers, { Pick: ["a", "b"] });
});

test("drive_share batch shares each address independently and reports per email", async () => {
  const created: any[] = [];
  const tools = createDriveTools(
    () =>
      ({
        permissions: {
          create: async (req: any) => {
            created.push(req);
            if (req.requestBody.emailAddress === "bad@x.y") throw new Error("Invalid email");
            return { data: { id: `p-${created.length}` } };
          },
        },
      }) as never,
    () => []
  );
  const out = json(
    await handler(tools, "drive_share")({
      account: "b",
      file_id: "folder-1",
      emails: ["a@x.y", "bad@x.y", "A@x.y", "c@x.y"],
      role: "commenter",
      notify: false,
      message: "ignored when not notifying",
    })
  );
  assert.equal(out.shared, 2);
  assert.equal(out.failed, 1);
  assert.deepEqual(out.results.map((r: any) => [r.email, r.ok]), [["a@x.y", true], ["bad@x.y", false], ["c@x.y", true]]);
  assert.equal(created[0].sendNotificationEmail, false);
  assert.equal(created[0].emailMessage, undefined);
  await assert.rejects(handler(tools, "drive_share")({ account: "b", file_id: "f", role: "owner", email: "a@x.y" }), /role must be/);
  await assert.rejects(handler(tools, "drive_share")({ account: "b", file_id: "f", role: "reader" }), /pass email or emails/);
});

test("drive_list_recent filters by modifiedTime, walks subfolders when recursive, newest first", async () => {
  const queries: string[] = [];
  const FOLDER = "application/vnd.google-apps.folder";
  const tree: Record<string, { files: any[]; folders: any[] }> = {
    root: {
      files: [
        { id: "f1", name: "old-ish", modifiedTime: "2026-09-21T00:00:00Z" },
        { id: "sub", name: "Sub", mimeType: FOLDER, modifiedTime: "2026-09-22T00:00:00Z" },
      ],
      folders: [{ id: "sub", name: "Sub" }],
    },
    sub: { files: [{ id: "f2", name: "newest", modifiedTime: "2026-09-23T00:00:00Z" }], folders: [] },
  };
  const tools = createDriveTools(
    () =>
      ({
        files: {
          list: async (req: any) => {
            queries.push(req.q);
            const id = /^'([^']+)'/.exec(req.q)![1];
            return { data: { files: req.q.includes("mimeType =") ? tree[id].folders : tree[id].files } };
          },
        },
      }) as never,
    () => []
  );
  const flat = json(await handler(tools, "drive_list_recent")({ account: "b", folder_id: "root", since: "2026-09-20" }));
  assert.deepEqual(flat.files.map((f: any) => f.id), ["f1"]);
  assert.equal(queries[0], "'root' in parents and trashed = false and modifiedTime > '2026-09-20T00:00:00.000Z'");

  const deep = json(await handler(tools, "drive_list_recent")({ account: "b", folder_id: "root", since: "2026-09-20", recursive: true }));
  assert.deepEqual(deep.files.map((f: any) => [f.id, f.path]), [["f2", "Sub"], ["f1", ""]]);
  assert.equal(deep.foldersVisited, 2);
  await assert.rejects(handler(tools, "drive_list_recent")({ account: "b", folder_id: "root", since: "nope" }), /not a date/);
});
