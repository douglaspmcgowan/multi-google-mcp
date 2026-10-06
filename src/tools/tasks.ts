import type { tasks_v1 } from "@googleapis/tasks";
import { getAuthenticatedClient } from "../auth.js";
import { getAccountNames } from "../config.js";
import { grantedScopes, withScope, type ScopeLookup } from "../scopes.js";
import type { ToolDef } from "./types.js";

type TasksClient = tasks_v1.Tasks;

export const TASKS_SCOPE = "https://www.googleapis.com/auth/tasks";
export const TASKS_READONLY_SCOPE = "https://www.googleapis.com/auth/tasks.readonly";

async function getTasks(account: string): Promise<TasksClient> {
  const { tasks } = await import("@googleapis/tasks");
  return tasks({ version: "v1", auth: getAuthenticatedClient(account) as never });
}

function accountDescription(getAccounts: () => string[]): string {
  let names: string[];
  try {
    names = getAccounts();
  } catch {
    return "Account availability could not be determined.";
  }
  if (names.length === 0) return "No accounts configured.";
  return `Available accounts: ${names.join(", ")}`;
}

function asText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** A bare date (YYYY-MM-DD) becomes midnight UTC, which is how Google Tasks stores a due date. */
export function normalizeDue(due: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}T00:00:00.000Z` : due;
}

function summarize(t: tasks_v1.Schema$Task) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    due: t.due,
    notes: t.notes,
    completed: t.completed,
    updated: t.updated,
    parent: t.parent,
    position: t.position,
  };
}

export function createTasksTools(
  getClient: (account: string) => TasksClient | Promise<TasksClient> = getTasks,
  getAccounts: () => string[] = getAccountNames,
  lookup: ScopeLookup = grantedScopes
): ToolDef[] {
  const account = { type: "string" as const, description: "Account label" };
  const listId = {
    type: "string" as const,
    description: "Task list ID from tasks_list_lists (default: '@default', the primary list)",
  };
  const taskId = { type: "string" as const, description: "Task ID" };
  const run = <T>(acct: string, fn: () => Promise<T>) => withScope(acct, [TASKS_SCOPE], lookup, fn);
  // Read tools also accept the read-only grant; write tools keep the full scope.
  const runRead = <T>(acct: string, fn: () => Promise<T>) =>
    withScope(acct, [TASKS_SCOPE, TASKS_READONLY_SCOPE], lookup, fn);

  return [
    {
      name: "tasks_list_lists",
      readOnly: true,
      description: `List the Google Tasks lists in an account. ${accountDescription(getAccounts)}`,
      inputSchema: { type: "object" as const, properties: { account }, required: ["account"] },
      handler: async (args: { account: string }) =>
        runRead(args.account, async () => {
          const tasks = await getClient(args.account);
          const res = await tasks.tasklists.list({ maxResults: 100 });
          return asText((res.data.items || []).map((l) => ({ id: l.id, title: l.title, updated: l.updated })));
        }),
    },
    {
      name: "tasks_list",
      readOnly: true,
      description: `List tasks in a Google Tasks list (up to max_results, default 100). Completed and hidden tasks are excluded unless requested; due_min/due_max (RFC 3339 or YYYY-MM-DD) bound the due date. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          list_id: listId,
          show_completed: { type: "boolean", description: "Include completed tasks (default false)" },
          show_hidden: { type: "boolean", description: "Include hidden tasks (default: same as show_completed)" },
          due_min: { type: "string", description: "Only tasks due at or after this (YYYY-MM-DD or RFC 3339)" },
          due_max: { type: "string", description: "Only tasks due before this (YYYY-MM-DD or RFC 3339)" },
          max_results: { type: "number", description: "Max tasks to return, 1-100 (default 100)" },
        },
        required: ["account"],
      },
      handler: async (args: {
        account: string;
        list_id?: string;
        show_completed?: boolean;
        show_hidden?: boolean;
        due_min?: string;
        due_max?: string;
        max_results?: number;
      }) =>
        runRead(args.account, async () => {
          const tasks = await getClient(args.account);
          const show =args.show_completed === true;
          const res = await tasks.tasks.list({
            tasklist: args.list_id || "@default",
            showCompleted: show,
            showHidden: args.show_hidden ?? show,
            maxResults: args.max_results || 100,
            ...(args.due_min ? { dueMin: normalizeDue(args.due_min) } : {}),
            ...(args.due_max ? { dueMax: normalizeDue(args.due_max) } : {}),
          });
          return asText((res.data.items || []).map(summarize));
        }),
    },
    {
      name: "tasks_create",
      readOnly: false,
      description: `Create a task in a Google Tasks list. due is an RFC 3339 timestamp or a YYYY-MM-DD date. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          list_id: listId,
          title: { type: "string", description: "Task title" },
          notes: { type: "string", description: "Task notes" },
          due: { type: "string", description: "Due date (YYYY-MM-DD or RFC 3339)" },
          parent: { type: "string", description: "Parent task ID, to create this as a subtask" },
          previous: { type: "string", description: "Sibling task ID to place this after (default: first)" },
        },
        required: ["account", "title"],
      },
      handler: async (args: {
        account: string;
        list_id?: string;
        title: string;
        notes?: string;
        due?: string;
        parent?: string;
        previous?: string;
      }) =>
        run(args.account, async () => {
          const tasks = await getClient(args.account);
          const requestBody: tasks_v1.Schema$Task = { title: args.title };
          if (args.notes !== undefined) requestBody.notes = args.notes;
          if (args.due) requestBody.due = normalizeDue(args.due);
          const res = await tasks.tasks.insert({
            tasklist: args.list_id || "@default",
            requestBody,
            ...(args.parent ? { parent: args.parent } : {}),
            ...(args.previous ? { previous: args.previous } : {}),
          });
          return asText(summarize(res.data));
        }),
    },
    {
      name: "tasks_update",
      readOnly: false,
      description: `Change a task's title, notes or due date. Pass due as an empty string to clear the due date. To change the parent or order use tasks_move. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          list_id: listId,
          task_id: taskId,
          title: { type: "string", description: "New title" },
          notes: { type: "string", description: "New notes" },
          due: { type: "string", description: "New due date (YYYY-MM-DD or RFC 3339)" },
        },
        required: ["account", "task_id"],
      },
      handler: async (args: {
        account: string;
        list_id?: string;
        task_id: string;
        title?: string;
        notes?: string;
        due?: string;
      }) =>
        run(args.account, async () => {
          const tasks = await getClient(args.account);
          const requestBody: tasks_v1.Schema$Task = {};
          if (args.title !== undefined) requestBody.title = args.title;
          if (args.notes !== undefined) requestBody.notes = args.notes;
          if (args.due !== undefined) requestBody.due = args.due === "" ? (null as unknown as string) : normalizeDue(args.due);
          if (Object.keys(requestBody).length === 0) throw new Error("Provide at least one of title, notes, due.");
          const res = await tasks.tasks.patch({
            tasklist: args.list_id || "@default",
            task: args.task_id,
            requestBody,
          });
          return asText(summarize(res.data));
        }),
    },
    {
      name: "tasks_complete",
      readOnly: false,
      description: `Mark a task completed, or reopen it with completed: false. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          list_id: listId,
          task_id: taskId,
          completed: { type: "boolean", description: "true (default) completes the task; false reopens it" },
        },
        required: ["account", "task_id"],
      },
      handler: async (args: { account: string; list_id?: string; task_id: string; completed?: boolean }) =>
        run(args.account, async () => {
          const tasks = await getClient(args.account);
          const done = args.completed !== false;
          const requestBody: tasks_v1.Schema$Task = done
            ? { status: "completed" }
            : { status: "needsAction", completed: null as unknown as string };
          const res = await tasks.tasks.patch({
            tasklist: args.list_id || "@default",
            task: args.task_id,
            requestBody,
          });
          return asText(summarize(res.data));
        }),
    },
    {
      name: "tasks_get",
      readOnly: true,
      description: `Get one task by ID. ${accountDescription(getAccounts)}`,
      inputSchema: { type: "object" as const, properties: { account, list_id: listId, task_id: taskId }, required: ["account", "task_id"] },
      handler: async (args: { account: string; list_id?: string; task_id: string }) =>
        runRead(args.account, async () => {
          const tasks = await getClient(args.account);
          const res = await tasks.tasks.get({ tasklist: args.list_id || "@default", task: args.task_id });
          return asText(summarize(res.data));
        }),
    },
    {
      name: "tasks_delete",
      readOnly: false,
      description: `DESTRUCTIVE: deletes a task (and its subtasks) from the list. ${accountDescription(getAccounts)}`,
      inputSchema: { type: "object" as const, properties: { account, list_id: listId, task_id: taskId }, required: ["account", "task_id"] },
      handler: async (args: { account: string; list_id?: string; task_id: string }) =>
        run(args.account, async () => {
          const tasks = await getClient(args.account);
          await tasks.tasks.delete({ tasklist: args.list_id || "@default", task: args.task_id });
          return asText({ deleted: args.task_id });
        }),
    },
    {
      name: "tasks_move",
      readOnly: false,
      description:
        "Reorder a task, make it a subtask of another task, promote it to top level, or move it to another list. " +
        "parent and previous are both optional; with neither, the task becomes the first top-level task of its list. " +
        `${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          list_id: listId,
          task_id: taskId,
          parent: { type: "string", description: "New parent task ID (omit for top level)" },
          previous: { type: "string", description: "Sibling task ID to place this task after (omit for first)" },
          destination_list_id: { type: "string", description: "Move the task to this other list ID" },
        },
        required: ["account", "task_id"],
      },
      handler: async (args: {
        account: string;
        list_id?: string;
        task_id: string;
        parent?: string;
        previous?: string;
        destination_list_id?: string;
      }) =>
        run(args.account, async () => {
          const tasks = await getClient(args.account);
          const res = await tasks.tasks.move({
            tasklist: args.list_id || "@default",
            task: args.task_id,
            ...(args.parent ? { parent: args.parent } : {}),
            ...(args.previous ? { previous: args.previous } : {}),
            ...(args.destination_list_id ? { destinationTasklist: args.destination_list_id } : {}),
          });
          return asText(summarize(res.data));
        }),
    },
    {
      name: "tasks_clear_completed",
      readOnly: false,
      description: `Hide every completed task in a list (the API's clear: they stop appearing in tasks_list unless show_hidden is true). ${accountDescription(getAccounts)}`,
      inputSchema: { type: "object" as const, properties: { account, list_id: listId }, required: ["account"] },
      handler: async (args: { account: string; list_id?: string }) =>
        run(args.account, async () => {
          const tasks = await getClient(args.account);
          await tasks.tasks.clear({ tasklist: args.list_id || "@default" });
          return asText({ cleared: args.list_id || "@default" });
        }),
    },
    {
      name: "tasks_create_list",
      readOnly: false,
      description: `Create a Google Tasks list. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: { account, title: { type: "string", description: "List title" } },
        required: ["account", "title"],
      },
      handler: async (args: { account: string; title: string }) =>
        run(args.account, async () => {
          const tasks = await getClient(args.account);
          const res = await tasks.tasklists.insert({ requestBody: { title: args.title } });
          return asText({ id: res.data.id, title: res.data.title });
        }),
    },
    {
      name: "tasks_rename_list",
      readOnly: false,
      description: `Rename a Google Tasks list. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          list_id: { type: "string", description: "Task list ID from tasks_list_lists" },
          title: { type: "string", description: "New list title" },
        },
        required: ["account", "list_id", "title"],
      },
      handler: async (args: { account: string; list_id: string; title: string }) =>
        run(args.account, async () => {
          const tasks = await getClient(args.account);
          const res = await tasks.tasklists.patch({ tasklist: args.list_id, requestBody: { title: args.title } });
          return asText({ id: res.data.id, title: res.data.title });
        }),
    },
    {
      name: "tasks_delete_list",
      readOnly: false,
      description: `DESTRUCTIVE: deletes a Google Tasks list and every task in it. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: { account, list_id: { type: "string", description: "Task list ID from tasks_list_lists" } },
        required: ["account", "list_id"],
      },
      handler: async (args: { account: string; list_id: string }) =>
        run(args.account, async () => {
          const tasks = await getClient(args.account);
          await tasks.tasklists.delete({ tasklist: args.list_id });
          return asText({ deleted: args.list_id });
        }),
    },
  ];
}

export const tasksTools = createTasksTools();
