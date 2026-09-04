import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { gmailTools } from "./tools/gmail.js";
import { calendarTools } from "./tools/calendar.js";
import { driveTools } from "./tools/drive.js";
import { getAccountNames } from "./config.js";
import { z } from "zod";

const server = new McpServer({
  name: "multi-google",
  version: "1.0.0",
});

// Convert JSON Schema-style inputSchema to Zod schemas for the MCP SDK
function jsonSchemaToZod(schema: any): Record<string, any> {
  const shape: Record<string, any> = {};
  const props = schema.properties || {};
  const required = new Set(schema.required || []);

  for (const [key, prop] of Object.entries(props) as any[]) {
    let zodType: any;
    if (prop.type === "string") {
      zodType = z.string().describe(prop.description || "");
    } else if (prop.type === "number") {
      zodType = z.number().describe(prop.description || "");
    } else if (prop.type === "boolean") {
      zodType = z.boolean().describe(prop.description || "");
    } else if (prop.type === "array") {
      zodType = z.array(z.string()).describe(prop.description || "");
    } else {
      zodType = z.string().describe(prop.description || "");
    }

    if (!required.has(key)) {
      zodType = zodType.optional();
    }

    shape[key] = zodType;
  }

  return shape;
}

// Register all tools
const allTools = [...gmailTools, ...calendarTools, ...driveTools];

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
              text: `Authentication expired for account "${args.account}". Run this in the terminal to re-authenticate:\n\ncd ~/multi-google-mcp && npm run add-account`,
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
