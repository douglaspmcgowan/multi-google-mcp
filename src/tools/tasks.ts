import type { tasks_v1 } from "@googleapis/tasks";
import { getAuthenticatedClient } from "../auth.js";
import { getAccountNames } from "../config.js";
import { grantedScopes, withScope, type ScopeLookup } from "../scopes.js";
import type { ToolDef } from "./types.js";

type TasksClient = tasks_v1.Tasks;

export const TASKS_SCOPE = "https://www.googleapis.com/auth/tasks";

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

  return [
    {
      name: "tasks_list_lists",
      readOnly: true,
      description: `List the Google Tasks lists in an account. ${accountDescription(getAccounts)}`,
      inputSchema: { type: "object" as const, properties: { account }, required: ["account"] },
      handler: async (args: { account: string }) =>
        run(args.account, async () => {
          const tasks = await getClient(args.account);
          const res = await tasks.tasklists.list({ maxResults: 100 });
          return asText((res.data.items || []).map((l) => ({ id: l.id, title: l.title, updated: l.updated })));
        }),
    },
    {
      name: "tasks_list",
      readOnly: true,
      description: `List tasks in a Google Tasks list. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          list_id: listId,
          show_completed: { type: "boolean", description: "Include completed tasks (default false)" },
        },
        required: ["account"],
      },
      handler: async (args: { account: string; list_id?: string; show_completed?: boolean }) =>
        run(args.account, async () => {
          const tasks = await getClient(args.account);
          const show = args.show_completed === true;
          const res = await tasks.tasks.list({
            tasklist: args.list_id || "@default",
            showCompleted: show,
            showHidden: show,
            maxResults: 100,
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
        },
        required: ["account", "title"],
      },
      handler: async (args: { account: string; list_id?: string; title: string; notes?: string; due?: string }) =>
        run(args.account, async () => {
          const tasks = await getClient(args.account);
          const requestBody: tasks_v1.Schema$Task = { title: args.title };
          if (args.notes !== undefined) requestBody.notes = args.notes;
          if (args.due) requestBody.due = normalizeDue(args.due);
          const res = await tasks.tasks.insert({ tasklist: args.list_id || "@default", requestBody });
          return asText(summarize(res.data));
        }),
    },
    {
      name: "tasks_update",
      readOnly: false,
      description: `Change a task's title, notes or due date. ${accountDescription(getAccounts)}`,
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
          if (args.due) requestBody.due = normalizeDue(args.due);
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
  ];
}

export const tasksTools = createTasksTools();
