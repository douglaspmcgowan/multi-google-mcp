import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import { wantsHttp } from "./transport.js";

async function main() {
  if (wantsHttp(process.argv.slice(2), process.env)) {
    const { startHttp } = await import("./http/start.js");
    await startHttp();
    return;
  }
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("Server failed to start:", err?.message ?? String(err));
  process.exit(1);
});
