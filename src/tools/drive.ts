import type { drive_v3 } from "@googleapis/drive";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { getAuthenticatedClient } from "../auth.js";
import { getAccountNames } from "../config.js";

type DriveClient = drive_v3.Drive;

async function getDrive(account: string): Promise<DriveClient> {
  const { drive } = await import("@googleapis/drive");
  return drive({ version: "v3", auth: getAuthenticatedClient(account) as never });
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

const fileFields = "id,name,mimeType,description,createdTime,modifiedTime,size,webViewLink,parents";
const permissionFields = "permissions(id,type,emailAddress,displayName,role,allowFileDiscovery,expirationTime)";

/**
 * Shorthands for the Google-native types, so a caller can say "doc" instead of
 * remembering `application/vnd.google-apps.document`.
 */
const NATIVE_TYPES: Record<string, string> = {
  doc: "application/vnd.google-apps.document",
  document: "application/vnd.google-apps.document",
  sheet: "application/vnd.google-apps.spreadsheet",
  spreadsheet: "application/vnd.google-apps.spreadsheet",
  slides: "application/vnd.google-apps.presentation",
  presentation: "application/vnd.google-apps.presentation",
  folder: "application/vnd.google-apps.folder",
};

export function resolveMimeType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return NATIVE_TYPES[value.toLowerCase()] || value;
}

/**
 * Picks the mime type Drive should read the uploaded bytes AS. HTML is the one
 * worth knowing: uploading `text/html` against a target type of Google Doc is
 * what produces a properly formatted document — headings, bold, links, tables —
 * without touching the Docs API.
 */
export function resolveContentMimeType(
  contentMimeType: string | undefined,
  html: string | undefined
): string {
  if (contentMimeType) return contentMimeType;
  return html === undefined ? "text/plain" : "text/html";
}

function bodyFor(html: string | undefined, text: string | undefined): string | undefined {
  if (html !== undefined) return html;
  if (text !== undefined) return text;
  return undefined;
}

function asText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function createDriveTools(
  getClient: (account: string) => DriveClient | Promise<DriveClient> = getDrive,
  getAccounts: () => string[] = getAccountNames
) {
  const account = { type: "string" as const, description: "Account label" };
  const fileId = { type: "string" as const, description: "Drive file ID" };

  return [
    {
      name: "drive_search",
      description: `Search files in a specific Google Drive account. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          query: { type: "string", description: "Drive query syntax" },
          max_results: { type: "number", description: "Max files to return (default 10)" },
        },
        required: ["account", "query"],
      },
      handler: async (args: { account: string; query: string; max_results?: number }) => {
        const drive = await getClient(args.account);
        const res = await drive.files.list({
          q: args.query,
          pageSize: args.max_results || 10,
          fields: `files(${fileFields})`,
        });
        return asText(res.data.files || []);
      },
    },
    {
      name: "drive_get_metadata",
      description: `Get metadata for a Drive file. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: { account, file_id: fileId },
        required: ["account", "file_id"],
      },
      handler: async (args: { account: string; file_id: string }) => {
        const drive = await getClient(args.account);
        const res = await drive.files.get({ fileId: args.file_id, fields: fileFields });
        return asText(res.data);
      },
    },
    {
      name: "drive_get_permissions",
      description: `List permissions for a Drive file. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: { account, file_id: fileId },
        required: ["account", "file_id"],
      },
      handler: async (args: { account: string; file_id: string }) => {
        const drive = await getClient(args.account);
        const res = await drive.permissions.list({ fileId: args.file_id, fields: permissionFields });
        return asText(res.data.permissions || []);
      },
    },
    {
      name: "drive_download",
      description: `Download a Drive file to disk. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          file_id: fileId,
          destination_path: { type: "string", description: "Destination path on disk" },
        },
        required: ["account", "file_id", "destination_path"],
      },
      handler: async (args: { account: string; file_id: string; destination_path: string }) => {
        const drive = await getClient(args.account);
        fs.mkdirSync(path.dirname(args.destination_path), { recursive: true });
        const res = await drive.files.get(
          { fileId: args.file_id, alt: "media" },
          { responseType: "stream" }
        );
        await pipeline(res.data as unknown as Readable, fs.createWriteStream(args.destination_path));
        const byteCount = fs.statSync(args.destination_path).size;
        return asText({ path: args.destination_path, byteCount });
      },
    },
    {
      name: "drive_export",
      description:
        "Export a Google-native file (Doc, Sheet, Slides) to disk in another format, for example " +
        "text/html, application/pdf, or text/plain. Use drive_download for files that are already " +
        `binary. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          file_id: fileId,
          export_mime_type: { type: "string", description: "Target format, e.g. text/html, text/plain, application/pdf" },
          destination_path: { type: "string", description: "Destination path on disk" },
        },
        required: ["account", "file_id", "export_mime_type", "destination_path"],
      },
      handler: async (args: {
        account: string;
        file_id: string;
        export_mime_type: string;
        destination_path: string;
      }) => {
        const drive = await getClient(args.account);
        fs.mkdirSync(path.dirname(args.destination_path), { recursive: true });
        const res = await drive.files.export(
          { fileId: args.file_id, mimeType: args.export_mime_type },
          { responseType: "stream" }
        );
        await pipeline(res.data as unknown as Readable, fs.createWriteStream(args.destination_path));
        const byteCount = fs.statSync(args.destination_path).size;
        return asText({ path: args.destination_path, byteCount, mimeType: args.export_mime_type });
      },
    },
    {
      name: "drive_share",
      description: `Share a Drive file with a user. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          file_id: fileId,
          email: { type: "string", description: "Recipient email address" },
          role: { type: "string", description: "Permission role (reader, commenter, or writer)" },
          notify: { type: "boolean", description: "Send Google's notification email (default true)" },
        },
        required: ["account", "file_id", "email", "role"],
      },
      handler: async (args: {
        account: string;
        file_id: string;
        email: string;
        role: string;
        notify?: boolean;
      }) => {
        const drive = await getClient(args.account);
        const res = await drive.permissions.create({
          fileId: args.file_id,
          sendNotificationEmail: args.notify !== false,
          requestBody: { type: "user", role: args.role, emailAddress: args.email },
          fields: "id",
        });
        return asText({
          fileId: args.file_id,
          email: args.email,
          role: args.role,
          permissionId: res.data.id,
        });
      },
    },
    {
      name: "drive_unshare",
      description:
        "Remove one permission from a Drive file. Get the permission id from drive_get_permissions. " +
        `${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          file_id: fileId,
          permission_id: { type: "string", description: "Permission ID from drive_get_permissions" },
        },
        required: ["account", "file_id", "permission_id"],
      },
      handler: async (args: { account: string; file_id: string; permission_id: string }) => {
        const drive = await getClient(args.account);
        await drive.permissions.delete({ fileId: args.file_id, permissionId: args.permission_id });
        return asText({ fileId: args.file_id, permissionId: args.permission_id, removed: true });
      },
    },
    {
      name: "drive_create",
      description:
        "Create a Drive file or folder. `mime_type` accepts the shorthands doc, sheet, slides and " +
        "folder, or any explicit mime type. Pass `html` to get a formatted Google Doc — headings, " +
        "bold, links and tables all survive the conversion — or `text` for plain content. Omit both " +
        `for an empty file. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          name: { type: "string", description: "File or folder name" },
          mime_type: { type: "string", description: "doc, sheet, slides, folder, or an explicit mime type (default doc)" },
          parent_id: { type: "string", description: "Parent folder ID (default: My Drive root)" },
          html: { type: "string", description: "HTML body; converted into the created file" },
          text: { type: "string", description: "Plain-text body; ignored when html is given" },
          content_mime_type: { type: "string", description: "How to read the body (default text/html for html, text/plain for text)" },
          description: { type: "string", description: "File description" },
        },
        required: ["account", "name"],
      },
      handler: async (args: {
        account: string;
        name: string;
        mime_type?: string;
        parent_id?: string;
        html?: string;
        text?: string;
        content_mime_type?: string;
        description?: string;
      }) => {
        const drive = await getClient(args.account);
        const targetType = resolveMimeType(args.mime_type) || NATIVE_TYPES.doc;
        const body = bodyFor(args.html, args.text);
        const request: Record<string, unknown> = {
          requestBody: {
            name: args.name,
            mimeType: targetType,
            ...(args.parent_id ? { parents: [args.parent_id] } : {}),
            ...(args.description ? { description: args.description } : {}),
          },
          fields: fileFields,
          supportsAllDrives: true,
        };
        if (body !== undefined) {
          request.media = {
            mimeType: resolveContentMimeType(args.content_mime_type, args.html),
            body,
          };
        }
        const res = await drive.files.create(request as never);
        return asText(res.data);
      },
    },
    {
      name: "drive_update_content",
      description:
        "Replace the contents of an existing Drive file. Pass `html` to rewrite a Google Doc with " +
        "formatting intact. This overwrites the whole file; read it first if you mean to edit it. " +
        `${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          file_id: fileId,
          html: { type: "string", description: "HTML body replacing the file's contents" },
          text: { type: "string", description: "Plain-text body; ignored when html is given" },
          content_mime_type: { type: "string", description: "How to read the body (default text/html for html, text/plain for text)" },
        },
        required: ["account", "file_id"],
      },
      handler: async (args: {
        account: string;
        file_id: string;
        html?: string;
        text?: string;
        content_mime_type?: string;
      }) => {
        const drive = await getClient(args.account);
        const body = bodyFor(args.html, args.text);
        if (body === undefined) {
          throw new Error("drive_update_content needs html or text");
        }
        const res = await drive.files.update({
          fileId: args.file_id,
          media: { mimeType: resolveContentMimeType(args.content_mime_type, args.html), body },
          fields: fileFields,
          supportsAllDrives: true,
        } as never);
        return asText(res.data);
      },
    },
    {
      name: "drive_upload",
      description:
        "Upload a local file to Drive. Set `convert` to true to turn it into the matching " +
        `Google-native type. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          source_path: { type: "string", description: "Path to the local file" },
          name: { type: "string", description: "Name in Drive (default: the file's own name)" },
          parent_id: { type: "string", description: "Parent folder ID (default: My Drive root)" },
          content_mime_type: { type: "string", description: "Mime type of the local file" },
          convert: { type: "boolean", description: "Convert to the matching Google-native type" },
        },
        required: ["account", "source_path"],
      },
      handler: async (args: {
        account: string;
        source_path: string;
        name?: string;
        parent_id?: string;
        content_mime_type?: string;
        convert?: boolean;
      }) => {
        const drive = await getClient(args.account);
        if (!fs.existsSync(args.source_path)) {
          throw new Error(`No such file: ${args.source_path}`);
        }
        const requestBody: Record<string, unknown> = {
          name: args.name || path.basename(args.source_path),
          ...(args.parent_id ? { parents: [args.parent_id] } : {}),
        };
        if (args.convert) {
          const ext = path.extname(args.source_path).toLowerCase();
          const target =
            ext === ".csv" || ext === ".xlsx" || ext === ".xls"
              ? NATIVE_TYPES.sheet
              : ext === ".pptx" || ext === ".ppt"
                ? NATIVE_TYPES.slides
                : NATIVE_TYPES.doc;
          requestBody.mimeType = target;
        }
        const res = await drive.files.create({
          requestBody,
          media: {
            ...(args.content_mime_type ? { mimeType: args.content_mime_type } : {}),
            body: fs.createReadStream(args.source_path),
          },
          fields: fileFields,
          supportsAllDrives: true,
        } as never);
        return asText(res.data);
      },
    },
    {
      name: "drive_rename",
      description: `Rename a Drive file or folder. The file ID and every existing link are unchanged. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: { account, file_id: fileId, name: { type: "string", description: "New name" } },
        required: ["account", "file_id", "name"],
      },
      handler: async (args: { account: string; file_id: string; name: string }) => {
        const drive = await getClient(args.account);
        const res = await drive.files.update({
          fileId: args.file_id,
          requestBody: { name: args.name },
          fields: fileFields,
          supportsAllDrives: true,
        } as never);
        return asText(res.data);
      },
    },
    {
      name: "drive_move",
      description: `Move a Drive file into another folder. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          file_id: fileId,
          parent_id: { type: "string", description: "Destination folder ID" },
        },
        required: ["account", "file_id", "parent_id"],
      },
      handler: async (args: { account: string; file_id: string; parent_id: string }) => {
        const drive = await getClient(args.account);
        const current = await drive.files.get({ fileId: args.file_id, fields: "parents" });
        const previous = (current.data.parents || []).join(",");
        const res = await drive.files.update({
          fileId: args.file_id,
          addParents: args.parent_id,
          ...(previous ? { removeParents: previous } : {}),
          fields: fileFields,
          supportsAllDrives: true,
        } as never);
        return asText(res.data);
      },
    },
    {
      name: "drive_copy",
      description: `Copy a Drive file. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          file_id: fileId,
          name: { type: "string", description: "Name for the copy" },
          parent_id: { type: "string", description: "Folder for the copy" },
        },
        required: ["account", "file_id"],
      },
      handler: async (args: { account: string; file_id: string; name?: string; parent_id?: string }) => {
        const drive = await getClient(args.account);
        const res = await drive.files.copy({
          fileId: args.file_id,
          requestBody: {
            ...(args.name ? { name: args.name } : {}),
            ...(args.parent_id ? { parents: [args.parent_id] } : {}),
          },
          fields: fileFields,
          supportsAllDrives: true,
        } as never);
        return asText(res.data);
      },
    },
    {
      name: "drive_trash",
      description:
        "Move a Drive file to the trash, where it stays recoverable. There is deliberately no " +
        `permanent-delete tool. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: { account, file_id: fileId },
        required: ["account", "file_id"],
      },
      handler: async (args: { account: string; file_id: string }) => {
        const drive = await getClient(args.account);
        const res = await drive.files.update({
          fileId: args.file_id,
          requestBody: { trashed: true },
          fields: fileFields,
          supportsAllDrives: true,
        } as never);
        return asText(res.data);
      },
    },
    {
      name: "drive_untrash",
      description: `Restore a Drive file from the trash. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: { account, file_id: fileId },
        required: ["account", "file_id"],
      },
      handler: async (args: { account: string; file_id: string }) => {
        const drive = await getClient(args.account);
        const res = await drive.files.update({
          fileId: args.file_id,
          requestBody: { trashed: false },
          fields: fileFields,
          supportsAllDrives: true,
        } as never);
        return asText(res.data);
      },
    },
  ];
}

export const driveTools = createDriveTools();
