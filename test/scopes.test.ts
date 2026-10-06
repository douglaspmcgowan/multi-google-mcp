import assert from "node:assert/strict";
import test from "node:test";
import { createTasksTools, TASKS_READONLY_SCOPE } from "../src/tools/tasks.js";
import { requireScope, SCOPE, ScopeError } from "../src/scopes.js";
import { READ_ONLY_SCOPES } from "../src/config.js";

const readOnlyGrant = () => [...READ_ONLY_SCOPES];

function tasksWith(lookup: (a: string) => string[] | undefined) {
  const client: any = {
    tasklists: { list: async () => ({ data: { items: [] } }) },
    tasks: {
      list: async () => ({ data: { items: [] } }),
      insert: async () => ({ data: { id: "x" } }),
    },
  };
  return createTasksTools(() => client, () => ["ro"], lookup);
}

test("SCOPE names every read-only grant the read tools accept", () => {
  for (const s of [SCOPE.driveReadonly, SCOPE.gmailReadonly, SCOPE.calendarReadonly, SCOPE.tasksReadonly, SCOPE.formsBodyReadonly]) {
    assert.ok(READ_ONLY_SCOPES.includes(s), s);
  }
});

test("tasks read tools accept the read-only grant; write tools do not", async () => {
  const tools = tasksWith(readOnlyGrant);
  const list = tools.find((t) => t.name === "tasks_list")!;
  await assert.doesNotReject(list.handler({ account: "ro" }));
  const lists = tools.find((t) => t.name === "tasks_list_lists")!;
  await assert.doesNotReject(lists.handler({ account: "ro" }));
  const create = tools.find((t) => t.name === "tasks_create")!;
  await assert.rejects(create.handler({ account: "ro", title: "t" }), ScopeError);
  assert.equal(TASKS_READONLY_SCOPE, SCOPE.tasksReadonly);
});

test("requireScope passes when any accepted scope is granted", () => {
  const lookup = () => [SCOPE.driveReadonly];
  assert.doesNotThrow(() => requireScope("a", [SCOPE.drive, SCOPE.driveReadonly], lookup));
  assert.throws(() => requireScope("a", [SCOPE.drive], lookup), ScopeError);
});
