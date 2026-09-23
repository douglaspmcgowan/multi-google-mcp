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

function writeClient(record: Array<{ method: string; request: any }>) {
  const capture = (method: string) => async (request: any) => {
    record.push({ method, request });
    return { data: { id: "file-1", name: "Result", parents: ["parent-1"] } };
  };
  return () => ({
    files: {
      list: async () => ({ data: { files: [] } }),
      get: async (request: any) => {
        record.push({ method: "get", request });
        return { data: { id: "file-1", parents: ["old-parent"] } };
      },
      create: capture("create"),
      update: capture("update"),
      copy: capture("copy"),
      export: capture("export"),
    },
    permissions: {
      list: async () => ({ data: { permissions: [] } }),
      create: async () => ({ data: { id: "permission-1" } }),
      delete: capture("permissions.delete"),
    },
  });
}

test("creates a Google Doc from HTML so the formatting survives", async () => {
  const record: Array<{ method: string; request: any }> = [];
  const tools = createDriveTools(writeClient(record) as never, () => []);

  await handler(tools, "drive_create")({
    account: "berkeley",
    name: "Docket",
    parent_id: "folder-1",
    html: "<h1>Docket</h1>",
  });

  const request = record[0].request;
  assert.equal(record[0].method, "create");
  assert.equal(request.requestBody.mimeType, "application/vnd.google-apps.document");
  assert.deepEqual(request.requestBody.parents, ["folder-1"]);
  assert.equal(request.media.mimeType, "text/html");
  assert.equal(request.media.body, "<h1>Docket</h1>");
});

test("creates a folder from the shorthand and carries no body", async () => {
  const record: Array<{ method: string; request: any }> = [];
  const tools = createDriveTools(writeClient(record) as never, () => []);

  await handler(tools, "drive_create")({ account: "berkeley", name: "Team", mime_type: "folder" });

  assert.equal(record[0].request.requestBody.mimeType, "application/vnd.google-apps.folder");
  assert.equal(record[0].request.media, undefined);
});

test("replaces a Doc's contents and refuses an empty body", async () => {
  const record: Array<{ method: string; request: any }> = [];
  const tools = createDriveTools(writeClient(record) as never, () => []);

  await handler(tools, "drive_update_content")({ account: "berkeley", file_id: "file-1", html: "<p>new</p>" });
  assert.equal(record[0].request.media.mimeType, "text/html");
  assert.equal(record[0].request.media.body, "<p>new</p>");

  await assert.rejects(
    () => handler(tools, "drive_update_content")({ account: "berkeley", file_id: "file-1" }),
    /needs html or text/
  );
});

test("renames without touching anything else", async () => {
  const record: Array<{ method: string; request: any }> = [];
  const tools = createDriveTools(writeClient(record) as never, () => []);

  await handler(tools, "drive_rename")({ account: "berkeley", file_id: "file-1", name: "DaVinci Demo Video" });

  assert.deepEqual(record[0].request.requestBody, { name: "DaVinci Demo Video" });
});

test("moving a file removes the parents it already had", async () => {
  const record: Array<{ method: string; request: any }> = [];
  const tools = createDriveTools(writeClient(record) as never, () => []);

  await handler(tools, "drive_move")({ account: "berkeley", file_id: "file-1", parent_id: "new-parent" });

  assert.equal(record[0].method, "get");
  assert.equal(record[1].request.addParents, "new-parent");
  assert.equal(record[1].request.removeParents, "old-parent");
});

test("trashing is recoverable and there is no permanent-delete tool", async () => {
  const record: Array<{ method: string; request: any }> = [];
  const tools = createDriveTools(writeClient(record) as never, () => []);

  await handler(tools, "drive_trash")({ account: "berkeley", file_id: "file-1" });
  assert.deepEqual(record[0].request.requestBody, { trashed: true });

  assert.equal(tools.find((tool) => tool.name === "drive_delete"), undefined);
});

test("exports a Doc to another format on disk", async () => {
  const tools = createDriveTools(() => ({
    files: {
      list: async () => ({ data: { files: [] } }),
      get: async () => ({ data: {} }),
      export: async (request: any) => {
        assert.equal(request.mimeType, "text/html");
        const { Readable } = await import("node:stream");
        return { data: Readable.from(["<h1>hi</h1>"]) };
      },
    },
    permissions: { list: async () => ({ data: { permissions: [] } }), create: async () => ({ data: {} }) },
  }) as never, () => []);

  const os = await import("node:os");
  const nodePath = await import("node:path");
  const fsMod = await import("node:fs");
  const dest = nodePath.join(os.tmpdir(), `drive-export-${Date.now()}.html`);

  const result = json(await handler(tools, "drive_export")({
    account: "berkeley",
    file_id: "file-1",
    export_mime_type: "text/html",
    destination_path: dest,
  }));

  assert.equal(fsMod.readFileSync(dest, "utf8"), "<h1>hi</h1>");
  assert.equal(result.mimeType, "text/html");
  fsMod.unlinkSync(dest);
});
