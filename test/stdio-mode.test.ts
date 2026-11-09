import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { wantsHttp } from "../src/transport.js";

test("transport selection: --http or MCP_TRANSPORT=http, stdio otherwise", () => {
  assert.equal(wantsHttp([], {}), false);
  assert.equal(wantsHttp(["--http"], {}), true);
  assert.equal(wantsHttp([], { MCP_TRANSPORT: "HTTP" }), true);
  assert.equal(wantsHttp([], { MCP_TRANSPORT: "stdio" }), false);
});

test("stdio mode still lists every tool", { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mgm-stdio-"));
  const cfg = path.join(dir, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ clientId: "x", clientSecret: "y", accounts: { work: { refresh_token: "fixture" } } }));
  const env = { ...process.env, MULTI_GOOGLE_CONFIG: cfg } as Record<string, string>;
  delete env.MCP_TRANSPORT;
  delete env.MULTI_GOOGLE_READ_ONLY;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", path.resolve("src/index.ts")],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-test", version: "1" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.length >= 190, `tools: ${tools.length}`);
  assert.ok(tools.some((t) => t.name === "google_list_accounts"));
  // Local-path tools still work locally: their path arguments are present in stdio mode.
  const dl = tools.find((t) => t.name === "drive_download")!;
  assert.ok(Object.keys((dl.inputSchema as any).properties).includes("destination_path"));
  await client.close();
});
