import assert from "node:assert/strict";
import test from "node:test";
import { createTasksTools, normalizeDue, TASKS_SCOPE } from "../src/tools/tasks.js";
import { SCOPES } from "../src/config.js";

function fake() {
  const calls: Record<string, any> = {};
  const client: any = {
    tasklists: { list: async (r: any) => ((calls.lists = r), { data: { items: [{ id: "L1", title: "My Tasks" }] } }) },
    tasks: {
      list: async (r: any) => ((calls.list = r), { data: { items: [{ id: "T1", title: "Pay rent", status: "needsAction" }] } }),
      insert: async (r: any) => ((calls.insert = r), { data: { id: "T2", title: r.requestBody.title } }),
      patch: async (r: any) => ((calls.patch = r), { data: { id: r.task, status: r.requestBody.status } }),
    },
  };
  const tools = createTasksTools(() => client, () => ["me"], () => undefined);
  const call = async (name: string, args: any) => {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `missing ${name}`);
    return JSON.parse((await t.handler(args)).content[0].text);
  };
  return { calls, call, tools };
}

test("tasks scope is requested", () => {
  assert.ok(SCOPES.includes(TASKS_SCOPE));
});

test("tasks_list_lists and tasks_list shape requests and output", async () => {
  const { calls, call } = fake();
  assert.deepEqual(await call("tasks_list_lists", { account: "me" }), [{ id: "L1", title: "My Tasks" }]);
  const out = await call("tasks_list", { account: "me" });
  assert.equal(calls.list.tasklist, "@default");
  assert.equal(calls.list.showCompleted, false);
  assert.equal(out[0].title, "Pay rent");
  await call("tasks_list", { account: "me", list_id: "L1", show_completed: true });
  assert.equal(calls.list.tasklist, "L1");
  assert.equal(calls.list.showCompleted, true);
});

test("tasks_create sends title, notes and a normalized due date", async () => {
  const { calls, call } = fake();
  await call("tasks_create", { account: "me", title: "Call", notes: "re: lease", due: "2026-10-08" });
  assert.deepEqual(calls.insert, {
    tasklist: "@default",
    requestBody: { title: "Call", notes: "re: lease", due: "2026-10-08T00:00:00.000Z" },
  });
  assert.equal(normalizeDue("2026-10-08T10:00:00Z"), "2026-10-08T10:00:00Z");
});

test("tasks_update patches only given fields and rejects an empty update", async () => {
  const { calls, call, tools } = fake();
  await call("tasks_update", { account: "me", task_id: "T1", title: "New" });
  assert.deepEqual(calls.patch, { tasklist: "@default", task: "T1", requestBody: { title: "New" } });
  await assert.rejects(() => tools.find((t) => t.name === "tasks_update")!.handler({ account: "me", task_id: "T1" }), /at least one/);
});

test("tasks_complete completes and reopens", async () => {
  const { calls, call } = fake();
  await call("tasks_complete", { account: "me", task_id: "T1" });
  assert.equal(calls.patch.requestBody.status, "completed");
  await call("tasks_complete", { account: "me", task_id: "T1", completed: false });
  assert.equal(calls.patch.requestBody.status, "needsAction");
  assert.equal(calls.patch.requestBody.completed, null);
});

test("the original task tools keep their read/write flags", () => {
  const { tools } = fake();
  const flags = Object.fromEntries(tools.map((t) => [t.name, t.readOnly]));
  for (const [name, ro] of Object.entries({ tasks_list_lists: true, tasks_list: true, tasks_create: false, tasks_update: false, tasks_complete: false })) {
    assert.equal(flags[name], ro, name);
  }
});

test("a token without the Tasks scope yields the add-account command naming the account", async () => {
  const tools = createTasksTools(() => ({}) as any, () => ["me"], () => ["https://www.googleapis.com/auth/gmail.modify"]);
  await assert.rejects(
    () => tools[0].handler({ account: "house" }),
    (e: Error) => /house/.test(e.message) && /npm run add-account -- --account house/.test(e.message)
  );
});

test("Google's insufficient-scope 403 is translated to the same message", async () => {
  const client: any = {
    tasklists: {
      list: async () => {
        throw new Error("Request had insufficient authentication scopes.");
      },
    },
  };
  const tools = createTasksTools(() => client, () => ["me"], () => undefined);
  await assert.rejects(() => tools[0].handler({ account: "me" }), /npm run add-account -- --account me/);
});
