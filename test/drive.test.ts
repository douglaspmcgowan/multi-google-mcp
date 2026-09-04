import assert from "node:assert/strict";
import test from "node:test";
import { SCOPES } from "../dist/config.js";
import { createDriveTools } from "../dist/tools/drive.js";

type Tool = {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
};

function handler(tools: readonly Tool[], name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool.handler;
}

function json(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

test("requests the single Drive scope needed for existing-file metadata and permissions", () => {
  assert.deepEqual(
    SCOPES.filter((scope) => scope.startsWith("https://www.googleapis.com/auth/drive")),
    ["https://www.googleapis.com/auth/drive"]
  );
});

test("searches files with the selected account and Drive query", async () => {
  const requests: Record<string, unknown>[] = [];
  const tools = createDriveTools(() => ({
    files: {
      list: async (request: Record<string, unknown>) => {
        requests.push(request);
        return { data: { files: [{ id: "file-1", name: "Report", mimeType: "text/plain" }] } };
      },
    },
    permissions: { list: async () => ({ data: { permissions: [] } }), create: async () => ({ data: {} }) },
  }), () => []);

  const result = await handler(tools, "drive_search")({
    account: "berkeley",
    query: "name contains 'Report' and trashed = false",
    max_results: 5,
  });

  assert.deepEqual(requests[0], {
    q: "name contains 'Report' and trashed = false",
    pageSize: 5,
    fields: "files(id,name,mimeType,description,createdTime,modifiedTime,size,webViewLink,parents)",
  });
  assert.equal(json(result)[0].id, "file-1");
});

test("gets metadata and permissions for a selected file", async () => {
  const requests: Array<{ method: string; request: Record<string, unknown> }> = [];
  const tools = createDriveTools(() => ({
    files: {
      list: async () => ({ data: { files: [] } }),
      get: async (request: Record<string, unknown>) => {
        requests.push({ method: "get", request });
        return { data: { id: "file-1", name: "Report", mimeType: "text/plain" } };
      },
    },
    permissions: {
      list: async (request: Record<string, unknown>) => {
        requests.push({ method: "permissions.list", request });
        return { data: { permissions: [{ id: "permission-1", type: "user", role: "reader" }] } };
      },
      create: async () => ({ data: {} }),
    },
  }), () => []);

  const metadata = json(await handler(tools, "drive_get_metadata")({ account: "personal", file_id: "file-1" }));
  const permissions = json(await handler(tools, "drive_get_permissions")({ account: "personal", file_id: "file-1" }));

  assert.equal(metadata.id, "file-1");
  assert.deepEqual(permissions, [{ id: "permission-1", type: "user", role: "reader" }]);
  assert.equal(requests[0].request.fields, "id,name,mimeType,description,createdTime,modifiedTime,size,webViewLink,parents");
  assert.equal(requests[1].request.fields, "permissions(id,type,emailAddress,displayName,role,allowFileDiscovery,expirationTime)");
});

test("shares a file with a requested email and role", async () => {
  const requests: Record<string, unknown>[] = [];
  const tools = createDriveTools(() => ({
    files: { list: async () => ({ data: { files: [] } }), get: async () => ({ data: {} }) },
    permissions: {
      list: async () => ({ data: { permissions: [] } }),
      create: async (request: Record<string, unknown>) => {
        requests.push(request);
        return { data: { id: "permission-1" } };
      },
    },
  }), () => []);

  const result = json(await handler(tools, "drive_share")({
    account: "work",
    file_id: "file-1",
    email: "person@example.com",
    role: "writer",
  }));

  assert.deepEqual(requests[0], {
    fileId: "file-1",
    sendNotificationEmail: true,
    requestBody: { type: "user", role: "writer", emailAddress: "person@example.com" },
    fields: "id",
  });
  assert.deepEqual(result, {
    fileId: "file-1",
    email: "person@example.com",
    role: "writer",
    permissionId: "permission-1",
  });
});
