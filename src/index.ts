import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { gmailTools } from "./tools/gmail.js";
import { calendarTools } from "./tools/calendar.js";
import { driveTools } from "./tools/drive.js";
import { docsTools } from "./tools/docs.js";
import { slidesTools } from "./tools/slides.js";
import { sheetsTools } from "./tools/sheets.js";
import { commentTools } from "./tools/comments.js";
import { chatTools } from "./tools/chat.js";
import { formsTools } from "./tools/forms.js";
import { reauthCommand } from "./scopes.js";
import { getAccountNames } from "./config.js";
import { jsonSchemaToZod } from "./schema.js";

const server = new McpServer({
  name: "multi-google",
  version: "1.0.0",
});

// Register all tools
const allTools = [
  ...gmailTools,
  ...calendarTools,
  ...driveTools,
  ...docsTools,
  ...slidesTools,
  ...sheetsTools,
  ...commentTools,
  ...chatTools,
  ...formsTools,
];

for (const tool of allTools) {
  const zodShape = jsonSchemaToZod(tool.inputSchema);
  server.tool(tool.name, tool.description, zodShape, async (args: any) => {
    try {
      return await tool.handler(args);
    } catch (error: any) {
      const message = error.message || String(error);
      // Surface useful error info for common issues
      if (message.includes("invalid_grant") || message.includes("Token has been expired")) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Authentication expired for account "${args.account}". Run this in PowerShell to re-authenticate:\n\n${reauthCommand(args.account)}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });
}

// Add a utility tool to list connected accounts
server.tool(
  "google_list_accounts",
  "List all connected Google accounts",
  {},
  async () => {
    const names = getAccountNames();
    if (names.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No accounts connected. Run this in the terminal:\n\ncd ~/multi-google-mcp && npm run setup",
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `Connected accounts: ${names.join(", ")}`,
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Server failed to start:", err);
  process.exit(1);
});
