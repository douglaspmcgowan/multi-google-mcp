import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SCOPES } from "../dist/config.js";
import { createChatTools, messageName } from "../dist/tools/chat.js";

type Tool = {
  name: string;
  readOnly: boolean;
  description: string;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
};

const A = "https://www.googleapis.com/auth/";
const json = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
const oldToken = () => [`${A}drive`, `${A}gmail.modify`];
const newToken = () => SCOPES;

type Call = { method: string; req: any };

function fakeClient(calls: Call[], opts: { dmMissing?: boolean } = {}) {
  const rec = (method: string, data: unknown = {}) => async (req: any) => {
    calls.push({ method, req });
    if (method === "spaces.findDirectMessage" && opts.dmMissing) throw Object.assign(new Error("Not found"), { code: 404 });
    return { data };
  };
  return () =>
    ({
      media: { upload: rec("media.upload", { attachmentDataRef: { attachmentUploadToken: "TOK" } }) },
      spaces: {
        create: rec("spaces.create", { name: "spaces/N", displayName: "New", spaceType: "SPACE" }),
        setup: rec("spaces.setup", { name: "spaces/S", spaceType: "GROUP_CHAT" }),
        findDirectMessage: rec("spaces.findDirectMessage", { name: "spaces/D", spaceType: "DIRECT_MESSAGE" }),
        get: rec("spaces.get", { name: "spaces/A", displayName: "Team", spaceDetails: { description: "d" } }),
        patch: rec("spaces.patch", { name: "spaces/A", displayName: "Renamed" }),
        members: {
          delete: rec("members.delete"),
          patch: rec("members.patch", { name: "spaces/A/members/1", role: "ROLE_ASSISTANT_MANAGER" }),
        },
        messages: {
          create: rec("messages.create", { name: "spaces/A/messages/9", thread: { name: "spaces/A/threads/t" } }),
          list: rec("messages.list", { messages: [{ name: "spaces/A/messages/1", text: "hi", sender: { name: "users/1" } }] }),
          get: rec("messages.get", { name: "spaces/A/messages/1", text: "hi" }),
          patch: rec("messages.patch", { name: "spaces/A/messages/1", text: "new" }),
          delete: rec("messages.delete"),
          reactions: {
            create: rec("reactions.create", { name: "spaces/A/messages/1/reactions/r", emoji: { unicode: "+1" } }),
            list: rec("reactions.list", { reactions: [{ name: "spaces/A/messages/1/reactions/r", emoji: { unicode: "+1" }, user: { name: "users/1" } }] }),
            delete: rec("reactions.delete"),
          },
        },
      },
    }) as never;
}

function setup(token = newToken, opts: { dmMissing?: boolean } = {}) {
  const calls: Call[] = [];
  const tools = createChatTools(fakeClient(calls, opts), () => [], token) as unknown as Tool[];
  const run = (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `missing tool ${name}`);
    return tool.handler({ account: "b", ...args });
  };
  return { calls, tools, run };
}

const NEW_TOOLS: Array<[string, boolean, Record<string, unknown>]> = [
  ["chat_create_space", false, { display_name: "X" }],
  ["chat_create_group_chat", false, { emails: ["a@x.y", "b@x.y"] }],
  ["chat_find_or_create_dm", false, { email: "a@x.y" }],
  ["chat_get_space", true, { space: "A" }],
  ["chat_update_space", false, { space: "A", display_name: "Y" }],
  ["chat_list_messages", true, { space: "A" }],
  ["chat_get_message", true, { space: "A", message: "1" }],
  ["chat_update_message", false, { space: "A", message: "1", text: "t" }],
  ["chat_delete_message", false, { space: "A", message: "1" }],
  ["chat_remove_member", false, { space: "A", email: "a@x.y" }],
  ["chat_update_member_role", false, { space: "A", email: "a@x.y", role: "manager" }],
  ["chat_add_reaction", false, { space: "A", message: "1", emoji: "+1" }],
  ["chat_list_reactions", true, { space: "A", message: "1" }],
  ["chat_remove_reaction", false, { reaction: "spaces/A/messages/1/reactions/r" }],
  ["chat_upload_attachment", false, { space: "A", file_path: fileURLToPath(import.meta.url) }],
];

test("every new chat tool is registered with the right readOnly flag", () => {
  const { tools } = setup();
  for (const [name, readOnly] of NEW_TOOLS) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, name);
    assert.equal(tool.readOnly, readOnly, name);
  }
  for (const name of ["chat_delete_message", "chat_remove_member", "chat_remove_reaction"]) {
    assert.match(tools.find((t) => t.name === name)!.description, /^DESTRUCTIVE/, name);
  }
});

test("every new chat tool refuses an old token before calling Google", async () => {
  for (const [name, , args] of NEW_TOOLS) {
    const { calls, run } = setup(oldToken);
    await assert.rejects(() => run(name, args), /Re-auth needed/, name);
    assert.equal(calls.length, 0, name);
  }
});

test("chat_create_space uses spaces.create, or spaces.setup when members are given", async () => {
  const a = setup();
  const out = json(await a.run("chat_create_space", { display_name: " Lab ", description: "d", guidelines: "g", external_users: true }));
  assert.equal(out.name, "spaces/N");
  assert.deepEqual(a.calls[0], {
    method: "spaces.create",
    req: { requestBody: { spaceType: "SPACE", displayName: "Lab", spaceDetails: { description: "d", guidelines: "g" }, externalUserAllowed: true } },
  });
  const b = setup();
  await b.run("chat_create_space", { display_name: "Lab", email: "a@x.y", emails: ["A@x.y", "c@x.y"] });
  assert.equal(b.calls[0].method, "spaces.setup");
  assert.equal(b.calls[0].req.requestBody.space.spaceType, "SPACE");
  assert.deepEqual(
    b.calls[0].req.requestBody.memberships,
    [{ member: { name: "users/a@x.y", type: "HUMAN" } }, { member: { name: "users/c@x.y", type: "HUMAN" } }]
  );
  await assert.rejects(() => a.run("chat_create_space", { display_name: "  " }), /display_name is empty/);
});

test("chat_create_group_chat needs two people and uses GROUP_CHAT setup", async () => {
  const { calls, run } = setup();
  await assert.rejects(() => run("chat_create_group_chat", { emails: ["a@x.y", "A@x.y"] }), /at least two/);
  assert.equal(calls.length, 0);
  await run("chat_create_group_chat", { emails: ["a@x.y", "b@x.y"] });
  assert.equal(calls[0].method, "spaces.setup");
  assert.equal(calls[0].req.requestBody.space.spaceType, "GROUP_CHAT");
  assert.equal(calls[0].req.requestBody.memberships.length, 2);
});

test("chat_find_or_create_dm finds, then creates only on not-found", async () => {
  const found = setup();
  const a = json(await found.run("chat_find_or_create_dm", { email: "a@x.y" }));
  assert.equal(a.created, false);
  assert.deepEqual(found.calls.map((c) => c.method), ["spaces.findDirectMessage"]);
  assert.equal(found.calls[0].req.name, "users/a@x.y");
  const missing = setup(newToken, { dmMissing: true });
  const b = json(await missing.run("chat_find_or_create_dm", { email: "a@x.y" }));
  assert.equal(b.created, true);
  assert.deepEqual(missing.calls.map((c) => c.method), ["spaces.findDirectMessage", "spaces.setup"]);
  assert.equal(missing.calls[1].req.requestBody.space.spaceType, "DIRECT_MESSAGE");
  assert.equal(missing.calls[1].req.requestBody.memberships.length, 1);
});

test("chat_get_space and chat_update_space normalise the space and build the updateMask", async () => {
  const { calls, run } = setup();
  const got = json(await run("chat_get_space", { space: "https://mail.google.com/chat/u/0/#chat/space/AAA1" }));
  assert.equal(got.description, "d");
  assert.deepEqual(calls[0], { method: "spaces.get", req: { name: "spaces/AAA1" } });
  await run("chat_update_space", { space: "A", display_name: "Renamed", description: "", guidelines: "g" });
  assert.deepEqual(calls[1], {
    method: "spaces.patch",
    req: {
      name: "spaces/A",
      updateMask: "displayName,spaceDetails.description,spaceDetails.guidelines",
      requestBody: { displayName: "Renamed", spaceDetails: { description: "", guidelines: "g" } },
    },
  });
  await assert.rejects(() => run("chat_update_space", { space: "A" }), /pass display_name/);
});

test("chat_list_messages builds the filter and order", async () => {
  const { calls, run } = setup();
  const out = json(await run("chat_list_messages", {
    space: "A", after: "2026-01-01T00:00:00Z", before: "2026-02-01T00:00:00Z", thread_name: "spaces/A/threads/t", order: "asc", max_results: 5,
  }));
  assert.equal(out[0].text, "hi");
  assert.equal(calls[0].method, "messages.list");
  assert.equal(calls[0].req.parent, "spaces/A");
  assert.equal(calls[0].req.pageSize, 5);
  assert.equal(calls[0].req.orderBy, "createTime asc");
  assert.equal(
    calls[0].req.filter,
    'createTime > "2026-01-01T00:00:00Z" AND createTime < "2026-02-01T00:00:00Z" AND thread.name = spaces/A/threads/t'
  );
  await run("chat_list_messages", { space: "A" });
  assert.equal(calls[1].req.orderBy, "createTime desc");
  assert.equal("filter" in calls[1].req, false);
});

test("message tools accept a bare id plus space or a full name", async () => {
  assert.equal(messageName("1", "A"), "spaces/A/messages/1");
  assert.equal(messageName("spaces/A/messages/1"), "spaces/A/messages/1");
  assert.throws(() => messageName("1"), /full message name/);
  const { calls, run } = setup();
  await run("chat_get_message", { message: "spaces/A/messages/1" });
  await run("chat_update_message", { space: "A", message: "1", text: "new" });
  await run("chat_delete_message", { space: "A", message: "1", force: true });
  assert.deepEqual(calls[0], { method: "messages.get", req: { name: "spaces/A/messages/1" } });
  assert.deepEqual(calls[1], { method: "messages.patch", req: { name: "spaces/A/messages/1", updateMask: "text", requestBody: { text: "new" } } });
  assert.deepEqual(calls[2], { method: "messages.delete", req: { name: "spaces/A/messages/1", force: true } });
  await assert.rejects(() => run("chat_update_message", { space: "A", message: "1", text: " " }), /text is empty/);
});

test("chat_remove_member and chat_update_member_role use the email alias or a membership name", async () => {
  const { calls, run } = setup();
  await run("chat_remove_member", { space: "A", email: " a@x.y " });
  await run("chat_remove_member", { membership: "spaces/A/members/7" });
  assert.deepEqual(calls[0], { method: "members.delete", req: { name: "spaces/A/members/a@x.y" } });
  assert.deepEqual(calls[1], { method: "members.delete", req: { name: "spaces/A/members/7" } });
  const role = json(await run("chat_update_member_role", { space: "A", email: "a@x.y", role: "Manager" }));
  assert.equal(role.role, "ROLE_ASSISTANT_MANAGER");
  assert.deepEqual(calls[2], {
    method: "members.patch",
    req: { name: "spaces/A/members/a@x.y", updateMask: "role", requestBody: { role: "ROLE_ASSISTANT_MANAGER" } },
  });
  await run("chat_update_member_role", { membership: "spaces/A/members/7", role: "member" });
  assert.equal(calls[3].req.requestBody.role, "ROLE_MEMBER");
  await assert.rejects(() => run("chat_update_member_role", { space: "A", email: "a@x.y", role: "owner" }), /manager/);
  await assert.rejects(() => run("chat_remove_member", { space: "A" }), /membership, or space plus email/);
});

test("reaction tools send the verified request shapes", async () => {
  const { calls, run } = setup();
  const added = json(await run("chat_add_reaction", { space: "A", message: "1", emoji: " +1 " }));
  assert.equal(added.emoji, "+1");
  assert.deepEqual(calls[0], { method: "reactions.create", req: { parent: "spaces/A/messages/1", requestBody: { emoji: { unicode: "+1" } } } });
  const listed = json(await run("chat_list_reactions", { space: "A", message: "1", emoji: "+1" }));
  assert.equal(listed[0].user, "users/1");
  assert.equal(calls[1].req.filter, 'emoji.unicode = "+1"');
  await run("chat_remove_reaction", { reaction: "spaces/A/messages/1/reactions/r" });
  assert.deepEqual(calls[2], { method: "reactions.delete", req: { name: "spaces/A/messages/1/reactions/r" } });
  await assert.rejects(() => run("chat_remove_reaction", { reaction: "r" }), /reaction must be/);
  await assert.rejects(() => run("chat_add_reaction", { space: "A", message: "1", emoji: " " }), /emoji is empty/);
});

test("chat_upload_attachment uploads media then posts the message with the token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-upload-"));
  const file = join(dir, "notes.pdf");
  writeFileSync(file, "pdf");
  const { calls, run } = setup();
  const out = json(await run("chat_upload_attachment", { space: "A", file_path: file, text: "see", thread_key: "k" }));
  assert.equal(out.uploaded, "notes.pdf");
  assert.equal(out.bytes, 3);
  assert.equal(calls[0].method, "media.upload");
  assert.equal(calls[0].req.parent, "spaces/A");
  assert.deepEqual(calls[0].req.requestBody, { filename: "notes.pdf" });
  assert.equal(calls[0].req.media.mimeType, "application/pdf");
  assert.equal(calls[1].method, "messages.create");
  assert.equal(calls[1].req.messageReplyOption, "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
  assert.deepEqual(calls[1].req.requestBody, {
    text: "see",
    attachment: [{ attachmentDataRef: { attachmentUploadToken: "TOK" }, contentName: "notes.pdf" }],
    thread: { threadKey: "k" },
  });
  const calls2 = setup();
  await assert.rejects(() => calls2.run("chat_upload_attachment", { space: "A", file_path: join(dir, "missing.txt") }), /ENOENT/);
  assert.equal(calls2.calls.length, 0);
});

test("a token with only the narrow reaction scope can react but not delete messages", async () => {
  const narrow = () => [`${A}chat.messages.reactions.create`];
  const { run } = setup(narrow);
  await run("chat_add_reaction", { space: "A", message: "1", emoji: "+1" });
  await assert.rejects(() => run("chat_delete_message", { space: "A", message: "1" }), /Re-auth needed/);
});
