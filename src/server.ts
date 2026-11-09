import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { gmailTools } from "./tools/gmail.js";
import { calendarTools } from "./tools/calendar.js";
import { meetTools } from "./tools/meet.js";
import { driveTools } from "./tools/drive.js";
import { docsTools } from "./tools/docs.js";
import { slidesTools } from "./tools/slides.js";
import { sheetsTools } from "./tools/sheets.js";
import { commentTools } from "./tools/comments.js";
import { chatTools } from "./tools/chat.js";
import { formsTools } from "./tools/forms.js";
import { tasksTools } from "./tools/tasks.js";
import { contactsTools } from "./tools/contacts.js";
import { filterTools, type ToolDef } from "./tools/types.js";
import { reauthCommand } from "./scopes.js";
import { getAccountNames, isReadOnlyMode, loadConfig } from "./config.js";
import { jsonSchemaToZod } from "./schema.js";
import { localPathRefusal } from "./http/local-paths.js";

export const allTools: ToolDef[] = [
  ...gmailTools,
  ...calendarTools,
  ...meetTools,
  ...driveTools,
  ...docsTools,
  ...slidesTools,
  ...sheetsTools,
  ...commentTools,
  ...chatTools,
  ...formsTools,
  ...tasksTools,
  ...contactsTools,
];

export interface ServerOptions {
  /** Remote (HTTP) mode: refuse local-path arguments and audit every call. */
  remote?: {
    audit: (entry: { tool: string; account: string | null; ok: boolean }) => void;
  };
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function errorResult(args: any, error: any): ToolResult {
  const message = error?.message || String(error);
  if (message.includes("invalid_grant") || message.includes("Token has been expired")) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Authentication expired for account "${args?.account}". Run this in PowerShell to re-authenticate:\n\n${reauthCommand(args?.account)}`,
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

/** Builds an McpServer with every tool registered. Stdio passes no options and behaves as before. */
export function createMcpServer(opts: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: "multi-google", version: "1.0.0" });

  let loadedConfig: { readOnly?: boolean } | undefined;
  try {
    loadedConfig = loadConfig();
  } catch {
    loadedConfig = undefined; // an unreadable config surfaces its own error at the first tool call
  }

  const remote = opts.remote;
  const wrap = (name: string, run: (args: any) => Promise<ToolResult>) => async (args: any): Promise<ToolResult> => {
    if (remote) {
      const refusal = localPathRefusal(name, args);
      if (refusal) {
        remote.audit({ tool: name, account: accountOf(args), ok: false });
        return { content: [{ type: "text" as const, text: refusal }], isError: true };
      }
    }
    let result: ToolResult;
    try {
      result = await run(args);
    } catch (error) {
      result = errorResult(args, error);
    }
    remote?.audit({ tool: name, account: accountOf(args), ok: !result.isError });
    return result;
  };

  for (const tool of filterTools(allTools, isReadOnlyMode(process.env, loadedConfig))) {
    server.tool(tool.name, tool.description, jsonSchemaToZod(tool.inputSchema), wrap(tool.name, (a) => tool.handler(a)) as any);
  }

  server.tool(
    "google_list_accounts",
    "List all connected Google accounts",
    {},
    wrap("google_list_accounts", async () => {
      const names = getAccountNames();
      if (names.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: remote
                ? "No accounts in the encrypted store. On the host run: npm run store:migrate"
                : "No accounts connected. Run this in the terminal:\n\ncd ~/multi-google-mcp && npm run setup",
            },
          ],
        };
      }
      return { content: [{ type: "text" as const, text: `Connected accounts: ${names.join(", ")}` }] };
    }) as any
  );

  return server;
}

function accountOf(args: any): string | null {
  return typeof args?.account === "string" ? args.account : null;
}
