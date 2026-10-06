import { test } from "node:test";
import assert from "node:assert/strict";
import { createGmailExtraTools } from "../src/tools/gmail.js";
import { ScopeError } from "../src/scopes.js";

const A = "https://www.googleapis.com/auth/";
const FULL = [`${A}gmail.modify`, `${A}gmail.compose`, `${A}gmail.labels`, `${A}gmail.settings.basic`];

function setup(scopes: string[] | undefined = FULL) {
  const calls: Array<{ m: string; req: any }> = [];
  const rec = (m: string, data: any = {}) => async (req: any) => {
    calls.push({ m, req });
    return { data };
  };
  const gmail = {
    users: {
      getProfile: rec("getProfile", { emailAddress: "a@b.c", historyId: "9" }),
      messages: { trash: rec("msg.trash"), untrash: rec("msg.untrash") },
      threads: { trash: rec("thr.trash"), untrash: rec("thr.untrash") },
      drafts: { send: rec("drafts.send", { id: "m1", threadId: "t1" }) },
      labels: {
        list: async () => ({ data: { labels: [{ id: "Label_7", name: "Receipts" }, { id: "INBOX", name: "INBOX" }] } }),
        create: rec("labels.create", { id: "Label_9" }),
        patch: rec("labels.patch", { id: "Label_7" }),
        delete: rec("labels.delete"),
      },
      history: { list: rec("history.list", { history: [] }) },
      settings: {
        filters: { list: rec("filters.list", { filter: [{ id: "f1" }] }), create: rec("filters.create", { id: "f2" }), delete: rec("filters.delete") },
        getVacation: rec("getVacation", { enableAutoReply: false }),
        updateVacation: rec("updateVacation", { enableAutoReply: true }),
        sendAs: {
          list: rec("sendAs.list", { sendAs: [{ sendAsEmail: "a@b.c", isPrimary: true, signature: "sig" }] }),
          patch: rec("sendAs.patch", { sendAsEmail: "a@b.c", signature: "new" }),
        },
      },
    },
  };
  const tools = createGmailExtraTools(async () => gmail, () => scopes);
  const call = async (name: string, args: any) => {
    const tool = tools.find((t) => t.name === name)!;
    const res = await tool.handler({ account: "x", ...args });
    return JSON.parse(res.content[0].text);
  };
  return { tools, calls, call };
}

test("every new tool is registered with an explicit readOnly flag and the right value", () => {
  const { tools } = setup();
  const ro = Object.fromEntries(tools.map((t) => [t.name, t.readOnly]));
  assert.deepEqual(ro, {
    gmail_trash: false, gmail_untrash: false, gmail_send_draft: false,
    gmail_create_label: false, gmail_update_label: false, gmail_delete_label: false,
    gmail_list_filters: true, gmail_create_filter: false, gmail_delete_filter: false,
    gmail_get_vacation: true, gmail_set_vacation: false,
    gmail_list_send_as: true, gmail_update_signature: false,
    gmail_get_profile: true, gmail_list_history: true,
  });
  for (const n of ["gmail_send_draft", "gmail_create_filter", "gmail_set_vacation", "gmail_update_signature"]) {
    assert.match(tools.find((t) => t.name === n)!.description, /SENDS|STANDING|ON it|appended/);
  }
});

test("trash and untrash call per-id endpoints for messages and threads", async () => {
  const { call, calls } = setup();
  assert.deepEqual(await call("gmail_trash", { message_ids: ["m1", "m2"], thread_ids: ["t1"] }), { trashed: { messages: 2, threads: 1 } });
  assert.deepEqual(calls.map((c) => [c.m, c.req.id]), [["msg.trash", "m1"], ["msg.trash", "m2"], ["thr.trash", "t1"]]);
  await call("gmail_untrash", { thread_ids: ["t1"] });
  assert.equal(calls.at(-1)!.m, "thr.untrash");
  await assert.rejects(() => call("gmail_trash", {}), /message_ids and\/or thread_ids/);
  await assert.rejects(() => call("gmail_trash", { message_ids: [""] }), /non-empty/);
});

test("gmail_send_draft posts the draft id", async () => {
  const { call, calls } = setup();
  assert.deepEqual(await call("gmail_send_draft", { draft_id: "d1" }), { sent: true, message_id: "m1", thread_id: "t1" });
  assert.deepEqual(calls[0].req, { userId: "me", requestBody: { id: "d1" } });
});

test("label create, update and delete send the right bodies and resolve names", async () => {
  const { call, calls } = setup();
  await call("gmail_create_label", { name: "Work/Tax", label_list_visibility: "labelHide", text_color: "#ffffff", background_color: "#16a766" });
  assert.deepEqual(calls[0].req.requestBody, {
    name: "Work/Tax", labelListVisibility: "labelHide", color: { textColor: "#ffffff", backgroundColor: "#16a766" },
  });
  await call("gmail_update_label", { label: "receipts", name: "Receipts 2026" });
  const patch = calls.find((c) => c.m === "labels.patch")!;
  assert.deepEqual(patch.req, { userId: "me", id: "Label_7", requestBody: { name: "Receipts 2026" } });
  await call("gmail_delete_label", { label: "Receipts" });
  assert.deepEqual(calls.find((c) => c.m === "labels.delete")!.req, { userId: "me", id: "Label_7" });
  await assert.rejects(() => call("gmail_create_label", { name: "x", label_list_visibility: "bad" }), /label_list_visibility/);
  await assert.rejects(() => call("gmail_create_label", { name: "x", text_color: "#fff" }), /together/);
  await assert.rejects(() => call("gmail_update_label", { label: "Receipts" }), /at least one field/);
  await assert.rejects(() => call("gmail_delete_label", { label: "Nope" }), /Label not found/);
});

test("filters: list, create maps criteria and actions, delete", async () => {
  const { call, calls } = setup();
  assert.deepEqual(await call("gmail_list_filters", {}), [{ id: "f1" }]);
  await call("gmail_create_filter", { from: "a@x.com", size: 5, size_comparison: "larger", add_labels: ["Receipts"], archive: true, mark_read: true, star: true });
  const create = calls.find((c) => c.m === "filters.create")!;
  assert.deepEqual(create.req.requestBody, {
    criteria: { from: "a@x.com", size: 5, sizeComparison: "larger" },
    action: { addLabelIds: ["Label_7", "STARRED"], removeLabelIds: ["UNREAD", "INBOX"] },
  });
  await assert.rejects(() => call("gmail_create_filter", { archive: true }), /criterion/);
  await assert.rejects(() => call("gmail_create_filter", { from: "a" }), /action/);
  await assert.rejects(() => call("gmail_create_filter", { size: 5, archive: true }), /size_comparison/);
  await call("gmail_delete_filter", { filter_id: "f1" });
  assert.deepEqual(calls.at(-1)!.req, { userId: "me", id: "f1" });
});

test("vacation get and set convert times and require a body when enabling", async () => {
  const { call, calls } = setup();
  await call("gmail_get_vacation", {});
  await call("gmail_set_vacation", { enabled: true, subject: "Away", body_text: "Back soon", end_time: "2026-10-10T00:00:00Z", start_time: "1000" });
  const body = calls.find((c) => c.m === "updateVacation")!.req.requestBody;
  assert.deepEqual(body, {
    enableAutoReply: true, responseSubject: "Away", responseBodyPlainText: "Back soon",
    startTime: "1000", endTime: String(Date.parse("2026-10-10T00:00:00Z")),
  });
  await assert.rejects(() => call("gmail_set_vacation", { enabled: true }), /body_text or body_html/);
  await assert.rejects(() => call("gmail_set_vacation", { enabled: true, body_text: "x", end_time: "nope" }), /end_time/);
  await call("gmail_set_vacation", { enabled: false });
  assert.deepEqual(calls.at(-1)!.req.requestBody, { enableAutoReply: false });
});

test("send-as list and signature patch", async () => {
  const { call, calls } = setup();
  const list = await call("gmail_list_send_as", {});
  assert.equal(list[0].signature, "sig");
  await call("gmail_update_signature", { send_as_email: "a@b.c", signature: "<b>me</b>" });
  assert.deepEqual(calls.at(-1)!.req, { userId: "me", sendAsEmail: "a@b.c", requestBody: { signature: "<b>me</b>" } });
  await assert.rejects(() => call("gmail_update_signature", { send_as_email: "a@b.c" }), /signature is required/);
});

test("profile and history", async () => {
  const { call, calls } = setup();
  assert.equal((await call("gmail_get_profile", {})).historyId, "9");
  await call("gmail_list_history", { start_history_id: "5", history_types: ["messageAdded"] });
  assert.deepEqual(calls.at(-1)!.req, {
    userId: "me", startHistoryId: "5", historyTypes: ["messageAdded"], labelId: undefined, maxResults: 100, pageToken: undefined,
  });
  await assert.rejects(() => call("gmail_list_history", {}), /start_history_id/);
});

test("a token lacking the needed scope is refused with a re-auth message before any call", async () => {
  const noSettings = setup([`${A}gmail.modify`, `${A}gmail.compose`, `${A}gmail.labels`]);
  for (const n of ["gmail_list_filters", "gmail_create_filter", "gmail_set_vacation", "gmail_update_signature"]) {
    await assert.rejects(() => noSettings.call(n, { enabled: false, from: "a", archive: true, send_as_email: "a", signature: "" }), ScopeError);
  }
  const readOnly = setup([`${A}gmail.readonly`]);
  await assert.rejects(() => readOnly.call("gmail_trash", { message_ids: ["m"] }), ScopeError);
  await assert.rejects(() => readOnly.call("gmail_send_draft", { draft_id: "d" }), ScopeError);
  await assert.rejects(() => readOnly.call("gmail_create_label", { name: "x" }), ScopeError);
  await readOnly.call("gmail_get_profile", {});
  assert.equal(noSettings.calls.length, 0);
  assert.equal(readOnly.calls.length, 1);
  const unknown = setup(undefined);
  await unknown.call("gmail_trash", { message_ids: ["m"] });
  assert.equal(unknown.calls.length, 1, "a token that records no scopes defers to Google");
});
