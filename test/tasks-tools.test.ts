import assert from "node:assert/strict";
import test from "node:test";
import { createTasksTools } from "../src/tools/tasks.js";

const READONLY = ["https://www.googleapis.com/auth/tasks.readonly"];

function fake(lookup: (a: string) => string[] | undefined = () => undefined) {
  const calls: Record<string, any> = {};
  const task = { id: "T1", title: "Pay rent", status: "needsAction", parent: "P1", position: "0001" };
  const client: any = {
    tasklists: {
      insert: async (r: any) => ((calls.listInsert = r), { data: { id: "L9", title: r.requestBody.title } }),
      patch: async (r: any) => ((calls.listPatch = r), { data: { id: r.tasklist, title: r.requestBody.title } }),
      delete: async (r: any) => ((calls.listDelete = r), { data: {} }),
    },
    tasks: {
      list: async (r: any) => ((calls.list = r), { data: { items: [task] } }),
      get: async (r: any) => ((calls.get = r), { data: task }),
      insert: async (r: any) => ((calls.insert = r), { data: { id: "T2", title: r.requestBody.title } }),
      patch: async (r: any) => ((calls.patch = r), { data: { id: r.task } }),
      delete: async (r: any) => ((calls.delete = r), { data: {} }),
      move: async (r: any) => ((calls.move = r), { data: { id: r.task, parent: r.parent } }),
      clear: async (r: any) => ((calls.clear = r), { data: {} }),
    },
  };
  const tools = createTasksTools(() => client, () => ["me"], lookup);
  const tool = (name: string) => {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `missing ${name}`);
    return t;
  };
  const call = async (name: string, args: any) => JSON.parse((await tool(name).handler(args)).content[0].text);
  return { calls, call, tool, tools };
}

test("every tasks tool is registered with the right readOnly flag", () => {
  const flags = Object.fromEntries(fake().tools.map((t) => [t.name, t.readOnly]));
  assert.deepEqual(flags, {
    tasks_list_lists: true,
    tasks_list: true,
    tasks_create: false,
    tasks_update: false,
    tasks_complete: false,
    tasks_get: true,
    tasks_delete: false,
    tasks_move: false,
    tasks_clear_completed: false,
    tasks_create_list: false,
    tasks_rename_list: false,
    tasks_delete_list: false,
  });
});

test("destructive tools say so", () => {
  const { tool } = fake();
  assert.match(tool("tasks_delete").description, /DESTRUCTIVE/);
  assert.match(tool("tasks_delete_list").description, /DESTRUCTIVE/);
});

test("tasks_list passes completed, hidden, due window and max_results", async () => {
  const { calls, call } = fake();
  const out = await call("tasks_list", {
    account: "me",
    show_completed: true,
    show_hidden: false,
    due_min: "2026-10-01",
    due_max: "2026-10-31T00:00:00.000Z",
    max_results: 25,
  });
  assert.equal(calls.list.showCompleted, true);
  assert.equal(calls.list.showHidden, false);
  assert.equal(calls.list.dueMin, "2026-10-01T00:00:00.000Z");
  assert.equal(calls.list.dueMax, "2026-10-31T00:00:00.000Z");
  assert.equal(calls.list.maxResults, 25);
  assert.equal(out[0].parent, "P1");
  await call("tasks_list", { account: "me" });
  assert.equal(calls.list.dueMin, undefined);
  assert.equal(calls.list.maxResults, 100);
});

test("tasks_create accepts parent and previous", async () => {
  const { calls, call } = fake();
  await call("tasks_create", { account: "me", title: "Sub", notes: "n", due: "2026-10-09", parent: "P1", previous: "T0" });
  assert.equal(calls.insert.parent, "P1");
  assert.equal(calls.insert.previous, "T0");
  assert.equal(calls.insert.requestBody.due, "2026-10-09T00:00:00.000Z");
  await call("tasks_create", { account: "me", title: "Top" });
  assert.equal("parent" in calls.insert, false);
});

test("tasks_update can clear the due date", async () => {
  const { calls, call } = fake();
  await call("tasks_update", { account: "me", task_id: "T1", due: "" });
  assert.equal(calls.patch.requestBody.due, null);
  await assert.rejects(() => call("tasks_update", { account: "me", task_id: "T1" }), /at least one/);
});

test("tasks_complete with completed:false reopens (covers uncomplete)", async () => {
  const { calls, call } = fake();
  await call("tasks_complete", { account: "me", task_id: "T1", completed: false });
  assert.equal(calls.patch.requestBody.status, "needsAction");
});

test("tasks_get and tasks_delete target the task and default list", async () => {
  const { calls, call } = fake();
  const t = await call("tasks_get", { account: "me", task_id: "T1" });
  assert.deepEqual([calls.get.tasklist, calls.get.task, t.id], ["@default", "T1", "T1"]);
  assert.deepEqual(await call("tasks_delete", { account: "me", list_id: "L1", task_id: "T1" }), { deleted: "T1" });
  assert.deepEqual([calls.delete.tasklist, calls.delete.task], ["L1", "T1"]);
});

test("tasks_move sends parent, previous and destination only when given", async () => {
  const { calls, call } = fake();
  await call("tasks_move", { account: "me", task_id: "T1", parent: "P2", previous: "T0", destination_list_id: "L2" });
  assert.deepEqual(calls.move, { tasklist: "@default", task: "T1", parent: "P2", previous: "T0", destinationTasklist: "L2" });
  await call("tasks_move", { account: "me", list_id: "L1", task_id: "T1" });
  assert.deepEqual(calls.move, { tasklist: "L1", task: "T1" });
});

test("tasks_clear_completed clears the list", async () => {
  const { calls, call } = fake();
  await call("tasks_clear_completed", { account: "me", list_id: "L1" });
  assert.deepEqual(calls.clear, { tasklist: "L1" });
  await call("tasks_clear_completed", { account: "me" });
  assert.deepEqual(calls.clear, { tasklist: "@default" });
});

test("list tools create, rename and delete", async () => {
  const { calls, call } = fake();
  assert.deepEqual(await call("tasks_create_list", { account: "me", title: "Home" }), { id: "L9", title: "Home" });
  assert.deepEqual(calls.listInsert.requestBody, { title: "Home" });
  await call("tasks_rename_list", { account: "me", list_id: "L9", title: "House" });
  assert.deepEqual(calls.listPatch, { tasklist: "L9", requestBody: { title: "House" } });
  assert.deepEqual(await call("tasks_delete_list", { account: "me", list_id: "L9" }), { deleted: "L9" });
  assert.deepEqual(calls.listDelete, { tasklist: "L9" });
});

test("scope refusal: a read-only token reads but every write names the re-auth command", async () => {
  const { call } = fake(() => READONLY);
  await call("tasks_get", { account: "me", task_id: "T1" });
  await call("tasks_list", { account: "me" });
  const writes: Array<[string, any]> = [
    ["tasks_delete", { task_id: "T1" }],
    ["tasks_move", { task_id: "T1" }],
    ["tasks_clear_completed", {}],
    ["tasks_create_list", { title: "x" }],
    ["tasks_rename_list", { list_id: "L", title: "x" }],
    ["tasks_delete_list", { list_id: "L" }],
  ];
  for (const [name, args] of writes) {
    await assert.rejects(() => call(name, { account: "me", ...args }), /npm run add-account -- --account me/, name);
  }
});
