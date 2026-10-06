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
const folderFields = "id,name,mimeType,modifiedTime,size,starred,owners(displayName,emailAddress),webViewLink,parents";
const revisionFields = "id,mimeType,modifiedTime,lastModifyingUser(displayName,emailAddress),size,keepForever,published,exportLinks";
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
  shortcut: "application/vnd.google-apps.shortcut",
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

      readOnly: true,
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
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        } as never);
        return asText(res.data.files || []);
      },
    },
    {
      name: "drive_list_recent",

      readOnly: true,
      description:
        "List files in a Drive folder changed since a date, newest first: id, name, mimeType, " +
        "modifiedTime, lastModifyingUser, webViewLink and path (the subfolder chain below the " +
        "given folder). recursive=true walks subfolders (up to max_folders). since takes a date " +
        `(YYYY-MM-DD, read as UTC midnight) or an ISO timestamp. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          folder_id: { type: "string", description: "Folder ID" },
          since: { type: "string", description: "Only files modified after this date/time" },
          recursive: { type: "boolean", description: "Include subfolders (default false)" },
          include_folders: { type: "boolean", description: "Also list changed folders themselves (default false)" },
          max_results: { type: "number", description: "Maximum files to return (default 100)" },
          max_folders: { type: "number", description: "Recursion cap on folders visited (default 200)" },
        },
        required: ["account", "folder_id", "since"],
      },
      handler: async (args: {
        account: string;
        folder_id: string;
        since: string;
        recursive?: boolean;
        include_folders?: boolean;
        max_results?: number;
        max_folders?: number;
      }) => {
        const parsed = new Date(args.since);
        if (Number.isNaN(parsed.getTime())) throw new Error(`since is not a date: ${args.since}`);
        const since = parsed.toISOString();
        const maxResults = args.max_results ?? 100;
        const maxFolders = args.max_folders ?? 200;
        const drive = await getClient(args.account);
        const listAll = async (q: string, fields: string) => {
          const out: drive_v3.Schema$File[] = [];
          let pageToken: string | undefined;
          do {
            const res = await drive.files.list({
              q,
              pageSize: 1000,
              pageToken,
              fields: `nextPageToken,files(${fields})`,
              supportsAllDrives: true,
              includeItemsFromAllDrives: true,
            } as never);
            const data = res.data as drive_v3.Schema$FileList;
            out.push(...(data.files ?? []));
            pageToken = data.nextPageToken ?? undefined;
          } while (pageToken);
          return out;
        };
        const quote = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        const recentFields = "id,name,mimeType,modifiedTime,lastModifyingUser(displayName,emailAddress),webViewLink,parents";
        const queue: Array<{ id: string; path: string }> = [{ id: args.folder_id, path: "" }];
        const visited = new Set<string>();
        const files: Array<Record<string, unknown>> = [];
        let truncatedFolders = false;
        while (queue.length) {
          const folder = queue.shift()!;
          if (visited.has(folder.id)) continue;
          if (visited.size >= maxFolders) {
            truncatedFolders = true;
            break;
          }
          visited.add(folder.id);
          const changed = await listAll(
            `'${quote(folder.id)}' in parents and trashed = false and modifiedTime > '${since}'`,
            recentFields
          );
          for (const file of changed) {
            if (file.mimeType === NATIVE_TYPES.folder && !args.include_folders) continue;
            files.push({ ...file, path: folder.path });
          }
          if (args.recursive) {
            const subfolders = await listAll(
              `'${quote(folder.id)}' in parents and trashed = false and mimeType = '${NATIVE_TYPES.folder}'`,
              "id,name"
            );
            for (const sub of subfolders) {
              if (sub.id) queue.push({ id: sub.id, path: folder.path ? `${folder.path}/${sub.name}` : sub.name ?? "" });
            }
          }
        }
        files.sort((a, b) => String(b.modifiedTime ?? "").localeCompare(String(a.modifiedTime ?? "")));
        return asText({
          folderId: args.folder_id,
          since,
          foldersVisited: visited.size,
          truncatedFolders,
          count: Math.min(files.length, maxResults),
          totalMatched: files.length,
          files: files.slice(0, maxResults),
        });
      },
    },
    {
      name: "drive_get_metadata",

      readOnly: true,
      description: `Get metadata for a Drive file. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: { account, file_id: fileId },
        required: ["account", "file_id"],
      },
      handler: async (args: { account: string; file_id: string }) => {
        const drive = await getClient(args.account);
        const res = await drive.files.get({ fileId: args.file_id, fields: fileFields, supportsAllDrives: true } as never);
        return asText(res.data);
      },
    },
    {
      name: "drive_get_permissions",

      readOnly: true,
      description: `List permissions for a Drive file. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: { account, file_id: fileId },
        required: ["account", "file_id"],
      },
      handler: async (args: { account: string; file_id: string }) => {
        const drive = await getClient(args.account);
        const res = await drive.permissions.list({ fileId: args.file_id, fields: permissionFields, supportsAllDrives: true } as never);
        return asText(res.data.permissions || []);
      },
    },
    {
      name: "drive_download",

      readOnly: false,
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

      readOnly: false,
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

      readOnly: false,
      description:
        "Share a Drive file or folder with one user (email) or many (emails) in one call, all " +
        "with the same role. Each address is shared independently: with emails the result lists " +
        "{email, ok, permissionId | error} per address, so one bad address does not stop the " +
        `rest. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          file_id: fileId,
          email: { type: "string", description: "Recipient email address (single)" },
          emails: { type: "array", description: "Recipient email addresses (batch)", items: { type: "string" } },
          role: { type: "string", description: "Permission role (reader, commenter, or writer)" },
          notify: { type: "boolean", description: "Send Google's notification email (default true)" },
          message: { type: "string", description: "Optional message included in the notification email" },
        },
        required: ["account", "file_id", "role"],
      },
      handler: async (args: {
        account: string;
        file_id: string;
        email?: string;
        emails?: string[];
        role: string;
        notify?: boolean;
        message?: string;
      }) => {
        const roles = ["reader", "commenter", "writer"];
        if (!roles.includes(args.role)) throw new Error(`role must be one of ${roles.join(", ")}`);
        const list = [...(args.email ? [args.email] : []), ...(args.emails ?? [])]
          .map((e) => e.trim())
          .filter(Boolean);
        const seen = new Set<string>();
        const unique = list.filter((e) => !seen.has(e.toLowerCase()) && seen.add(e.toLowerCase()));
        if (!unique.length) throw new Error("pass email or emails");
        const drive = await getClient(args.account);
        const notify = args.notify !== false;
        const results: Array<{ email: string; ok: boolean; permissionId?: string; error?: string }> = [];
        for (const email of unique) {
          try {
            const res = await drive.permissions.create({
              fileId: args.file_id,
              sendNotificationEmail: notify,
              ...(notify && args.message ? { emailMessage: args.message } : {}),
              requestBody: { type: "user", role: args.role, emailAddress: email },
              fields: "id",
              supportsAllDrives: true,
            } as never);
            results.push({ email, ok: true, permissionId: (res.data as { id?: string }).id ?? undefined });
          } catch (error) {
            results.push({ email, ok: false, error: (error as Error)?.message ?? String(error) });
          }
        }
        if (!args.emails) {
          if (!results[0].ok) throw new Error(results[0].error);
          return asText({ fileId: args.file_id, email: unique[0], role: args.role, permissionId: results[0].permissionId });
        }
        return asText({
          fileId: args.file_id,
          role: args.role,
          notify,
          shared: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
          results,
        });
      },
    },
    {
      name: "drive_unshare",

      readOnly: false,
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
        await drive.permissions.delete({ fileId: args.file_id, permissionId: args.permission_id, supportsAllDrives: true } as never);
        return asText({ fileId: args.file_id, permissionId: args.permission_id, removed: true });
      },
    },
    {
      name: "drive_create",

      readOnly: false,
      description:
        "Create a Drive file or folder. `mime_type` accepts the shorthands doc, sheet, slides and " +
        "folder, or any explicit mime type. Pass `html` to get a formatted Google Doc — headings, " +
        "bold, links and tables all survive the conversion — or `text` for plain content. Omit both " +
        "for an empty file. Pass `shortcut_target_id` to create a Drive shortcut to that file or " +
        `folder instead (no body allowed). ${accountDescription(getAccounts)}`,
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
          shortcut_target_id: {
            type: "string",
            description: "Create a shortcut pointing at this file or folder ID; sets mime type to shortcut",
          },
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
        shortcut_target_id?: string;
      }) => {
        const requestedType = resolveMimeType(args.mime_type);
        const body = bodyFor(args.html, args.text);
        const isShortcut = Boolean(args.shortcut_target_id) || requestedType === NATIVE_TYPES.shortcut;
        if (isShortcut) {
          if (!args.shortcut_target_id) {
            throw new Error("drive_create: a shortcut needs shortcut_target_id");
          }
          if (requestedType && requestedType !== NATIVE_TYPES.shortcut) {
            throw new Error(`drive_create: shortcut_target_id conflicts with mime_type ${args.mime_type}`);
          }
          if (body !== undefined) {
            throw new Error("drive_create: a shortcut cannot carry html or text");
          }
        }
        const drive = await getClient(args.account);
        const targetType = isShortcut ? NATIVE_TYPES.shortcut : requestedType || NATIVE_TYPES.doc;
        const request: Record<string, unknown> = {
          requestBody: {
            name: args.name,
            mimeType: targetType,
            ...(isShortcut ? { shortcutDetails: { targetId: args.shortcut_target_id } } : {}),
            ...(args.parent_id ? { parents: [args.parent_id] } : {}),
            ...(args.description ? { description: args.description } : {}),
          },
          fields: isShortcut ? `${fileFields},shortcutDetails` : fileFields,
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

      readOnly: false,
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

      readOnly: false,
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

      readOnly: false,
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

      readOnly: false,
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
        const current = await drive.files.get({ fileId: args.file_id, fields: "parents", supportsAllDrives: true } as never);
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

      readOnly: false,
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

      readOnly: false,
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

      readOnly: false,
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
    {
      name: "drive_list_folder",

      readOnly: true,
      description:
        "List the direct children of a Drive folder, one page per call: id, name, mimeType, " +
        "modifiedTime, size, starred, owners, webViewLink. Pass the returned nextPageToken back as " +
        "page_token for the next page. Works in shared drives. Use drive_search for queries and " +
        `drive_list_recent for changes since a date. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          folder_id: { type: "string", description: "Folder ID ('root' for My Drive root)" },
          page_size: { type: "number", description: "Items per page (default 100, max 1000)" },
          page_token: { type: "string", description: "nextPageToken from the previous page" },
          order_by: { type: "string", description: "Drive orderBy, e.g. 'folder,name' (default) or 'modifiedTime desc'" },
          include_trashed: { type: "boolean", description: "Include trashed children (default false)" },
        },
        required: ["account", "folder_id"],
      },
      handler: async (args: {
        account: string;
        folder_id: string;
        page_size?: number;
        page_token?: string;
        order_by?: string;
        include_trashed?: boolean;
      }) => {
        const drive = await getClient(args.account);
        const escaped = args.folder_id.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        const res = await drive.files.list({
          q: `'${escaped}' in parents${args.include_trashed ? "" : " and trashed = false"}`,
          pageSize: Math.min(1000, args.page_size ?? 100),
          ...(args.page_token ? { pageToken: args.page_token } : {}),
          orderBy: args.order_by ?? "folder,name",
          fields: `nextPageToken,files(${folderFields})`,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        } as never);
        const data = res.data as drive_v3.Schema$FileList;
        return asText({
          folderId: args.folder_id,
          count: (data.files ?? []).length,
          nextPageToken: data.nextPageToken ?? null,
          files: data.files ?? [],
        });
      },
    },
    {
      name: "drive_list_shared_drives",

      readOnly: true,
      description:
        "List the shared drives (team drives) the account can see: id, name, createdTime, hidden. " +
        "Use a shared drive's id as a folder_id for drive_list_folder or as a parent_id. " +
        `${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          page_size: { type: "number", description: "Items per page (default 100, max 100)" },
          page_token: { type: "string", description: "nextPageToken from the previous page" },
          query: { type: "string", description: "Optional drives query, e.g. name contains 'Lab'" },
        },
        required: ["account"],
      },
      handler: async (args: { account: string; page_size?: number; page_token?: string; query?: string }) => {
        const drive = await getClient(args.account);
        const res = await drive.drives.list({
          pageSize: Math.min(100, args.page_size ?? 100),
          ...(args.page_token ? { pageToken: args.page_token } : {}),
          ...(args.query ? { q: args.query } : {}),
          fields: "nextPageToken,drives(id,name,createdTime,hidden)",
        } as never);
        const data = res.data as drive_v3.Schema$DriveList;
        return asText({ count: (data.drives ?? []).length, nextPageToken: data.nextPageToken ?? null, drives: data.drives ?? [] });
      },
    },
    {
      name: "drive_list_revisions",

      readOnly: true,
      description:
        "List a file's saved revisions (version history), oldest first: id, modifiedTime, " +
        "lastModifyingUser, size, keepForever, exportLinks. Google-native files (Docs, Sheets, " +
        "Slides) list revisions but their content is only reachable through exportLinks; " +
        "drive_download_revision works on binary files. " +
        `${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          file_id: fileId,
          page_size: { type: "number", description: "Revisions per page (default 200, max 1000)" },
          page_token: { type: "string", description: "nextPageToken from the previous page" },
        },
        required: ["account", "file_id"],
      },
      handler: async (args: { account: string; file_id: string; page_size?: number; page_token?: string }) => {
        const drive = await getClient(args.account);
        const res = await drive.revisions.list({
          fileId: args.file_id,
          pageSize: Math.min(1000, args.page_size ?? 200),
          ...(args.page_token ? { pageToken: args.page_token } : {}),
          fields: `nextPageToken,revisions(${revisionFields})`,
        } as never);
        const data = res.data as drive_v3.Schema$RevisionList;
        return asText({
          fileId: args.file_id,
          count: (data.revisions ?? []).length,
          nextPageToken: data.nextPageToken ?? null,
          revisions: data.revisions ?? [],
        });
      },
    },
    {
      name: "drive_download_revision",

      readOnly: false,
      description:
        "Download one revision of a binary Drive file (PDF, image, uploaded Office file) to disk. " +
        "Get the revision id from drive_list_revisions. Not available for Google-native files, " +
        "which only expose exportLinks. Writes a local file, so it is a write tool. " +
        `${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          file_id: fileId,
          revision_id: { type: "string", description: "Revision ID from drive_list_revisions" },
          destination_path: { type: "string", description: "Destination path on disk" },
        },
        required: ["account", "file_id", "revision_id", "destination_path"],
      },
      handler: async (args: { account: string; file_id: string; revision_id: string; destination_path: string }) => {
        const drive = await getClient(args.account);
        fs.mkdirSync(path.dirname(args.destination_path), { recursive: true });
        const res = await drive.revisions.get(
          { fileId: args.file_id, revisionId: args.revision_id, alt: "media" } as never,
          { responseType: "stream" }
        );
        await pipeline(res.data as unknown as Readable, fs.createWriteStream(args.destination_path));
        const byteCount = fs.statSync(args.destination_path).size;
        return asText({ path: args.destination_path, byteCount, revisionId: args.revision_id });
      },
    },
    {
      name: "drive_update_permission",

      readOnly: false,
      description:
        "Change an existing permission in place: a new role (reader, commenter, writer, " +
        "fileOrganizer, organizer) and/or an expiration time (ISO 8601; expiry applies to user " +
        "and group permissions). Get the permission id from drive_get_permissions. To hand over " +
        `ownership use drive_transfer_ownership. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          file_id: fileId,
          permission_id: { type: "string", description: "Permission ID from drive_get_permissions" },
          role: { type: "string", description: "New role: reader, commenter, writer, fileOrganizer or organizer" },
          expiration_time: { type: "string", description: "ISO 8601 expiry; omit to leave unchanged" },
        },
        required: ["account", "file_id", "permission_id"],
      },
      handler: async (args: {
        account: string;
        file_id: string;
        permission_id: string;
        role?: string;
        expiration_time?: string;
      }) => {
        const roles = ["reader", "commenter", "writer", "fileOrganizer", "organizer"];
        if (args.role !== undefined && !roles.includes(args.role)) throw new Error(`role must be one of ${roles.join(", ")}`);
        if (args.role === undefined && args.expiration_time === undefined) {
          throw new Error("drive_update_permission needs role or expiration_time");
        }
        const drive = await getClient(args.account);
        const res = await drive.permissions.update({
          fileId: args.file_id,
          permissionId: args.permission_id,
          requestBody: {
            ...(args.role ? { role: args.role } : {}),
            ...(args.expiration_time ? { expirationTime: args.expiration_time } : {}),
          },
          fields: "id,type,emailAddress,role,expirationTime,pendingOwner",
          supportsAllDrives: true,
        } as never);
        return asText(res.data);
      },
    },
    {
      name: "drive_transfer_ownership",

      readOnly: false,
      description:
        "Hand ownership of a My Drive file to another user. mode=direct sets role owner with " +
        "transferOwnership: it works inside one Google Workspace domain. mode=pending marks the " +
        "user as pending owner (role writer, pendingOwner): required for consumer accounts " +
        "(gmail.com), and the recipient must then accept in Drive before ownership moves. " +
        "mode=auto (default) uses pending for gmail.com/googlemail.com addresses and direct " +
        "otherwise. Shared-drive items have no owner and cannot be transferred. Creates the " +
        "permission first when the user has none. Hard to undo: the new owner controls the file. " +
        `${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          file_id: fileId,
          email: { type: "string", description: "New owner's email address" },
          mode: { type: "string", description: "auto (default), direct or pending" },
        },
        required: ["account", "file_id", "email"],
      },
      handler: async (args: { account: string; file_id: string; email: string; mode?: string }) => {
        const email = args.email.trim();
        if (!email) throw new Error("email is required");
        const requested = args.mode ?? "auto";
        if (!["auto", "direct", "pending"].includes(requested)) throw new Error("mode must be auto, direct or pending");
        const mode =
          requested === "auto" ? (/@(gmail|googlemail)\.com$/i.test(email) ? "pending" : "direct") : requested;
        const drive = await getClient(args.account);
        const listed = await drive.permissions.list({
          fileId: args.file_id,
          fields: permissionFields,
          supportsAllDrives: true,
        } as never);
        const existing = (listed.data.permissions ?? []).find(
          (p) => p.emailAddress?.toLowerCase() === email.toLowerCase()
        );
        const body = mode === "direct" ? { role: "owner" } : { role: "writer", pendingOwner: true };
        const fields = "id,type,emailAddress,role,pendingOwner";
        let res;
        if (existing?.id) {
          res = await drive.permissions.update({
            fileId: args.file_id,
            permissionId: existing.id,
            ...(mode === "direct" ? { transferOwnership: true } : {}),
            requestBody: body,
            fields,
            supportsAllDrives: true,
          } as never);
        } else {
          res = await drive.permissions.create({
            fileId: args.file_id,
            ...(mode === "direct" ? { transferOwnership: true } : {}),
            sendNotificationEmail: true,
            requestBody: { type: "user", emailAddress: email, ...body },
            fields,
            supportsAllDrives: true,
          } as never);
        }
        return asText({ fileId: args.file_id, email, mode, permission: res.data });
      },
    },
    {
      name: "drive_set_link_sharing",

      readOnly: false,
      description:
        "Turn link sharing on or off for a file or folder. access=anyone: anyone with the link; " +
        "access=domain (needs domain): anyone in that Workspace domain with the link; access=off " +
        "removes the anyone/domain permission. role is reader (default), commenter or writer. " +
        "allow_file_discovery=true makes it findable in search, not just by link. Updates the " +
        "existing link permission when there is one. Individual shares are untouched. " +
        `${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          file_id: fileId,
          access: { type: "string", description: "anyone, domain or off" },
          role: { type: "string", description: "reader (default), commenter or writer" },
          domain: { type: "string", description: "Workspace domain, required for access=domain" },
          allow_file_discovery: { type: "boolean", description: "Make it discoverable in search (default false)" },
        },
        required: ["account", "file_id", "access"],
      },
      handler: async (args: {
        account: string;
        file_id: string;
        access: string;
        role?: string;
        domain?: string;
        allow_file_discovery?: boolean;
      }) => {
        if (!["anyone", "domain", "off"].includes(args.access)) throw new Error("access must be anyone, domain or off");
        const role = args.role ?? "reader";
        if (!["reader", "commenter", "writer"].includes(role)) throw new Error("role must be reader, commenter or writer");
        if (args.access === "domain" && !args.domain) throw new Error("access=domain needs domain");
        const drive = await getClient(args.account);
        const listed = await drive.permissions.list({
          fileId: args.file_id,
          fields: permissionFields,
          supportsAllDrives: true,
        } as never);
        const links = (listed.data.permissions ?? []).filter((p) => p.type === "anyone" || p.type === "domain");
        if (args.access === "off") {
          for (const link of links) {
            await drive.permissions.delete({ fileId: args.file_id, permissionId: link.id!, supportsAllDrives: true } as never);
          }
          return asText({ fileId: args.file_id, access: "off", removed: links.map((l) => l.id) });
        }
        const sameType = links.find((p) => p.type === args.access);
        let res;
        if (sameType?.id) {
          res = await drive.permissions.update({
            fileId: args.file_id,
            permissionId: sameType.id,
            requestBody: { role },
            fields: "id,type,role,domain,allowFileDiscovery",
            supportsAllDrives: true,
          } as never);
        } else {
          res = await drive.permissions.create({
            fileId: args.file_id,
            requestBody: {
              type: args.access,
              role,
              allowFileDiscovery: args.allow_file_discovery === true,
              ...(args.access === "domain" ? { domain: args.domain } : {}),
            },
            fields: "id,type,role,domain,allowFileDiscovery",
            supportsAllDrives: true,
          } as never);
        }
        return asText({ fileId: args.file_id, access: args.access, permission: res.data });
      },
    },
    {
      name: "drive_star",

      readOnly: false,
      description: `Star or unstar a Drive file or folder (starred=false unstars). ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          file_id: fileId,
          starred: { type: "boolean", description: "true to star, false to unstar" },
        },
        required: ["account", "file_id", "starred"],
      },
      handler: async (args: { account: string; file_id: string; starred: boolean }) => {
        const drive = await getClient(args.account);
        const res = await drive.files.update({
          fileId: args.file_id,
          requestBody: { starred: !!args.starred },
          fields: `${fileFields},starred`,
          supportsAllDrives: true,
        } as never);
        return asText(res.data);
      },
    },
    {
      name: "drive_update_metadata",

      readOnly: false,
      description:
        "Update a file's description and/or custom properties without touching its content. " +
        "properties is a string-to-string map merged into the file's existing properties; a null " +
        "value deletes that key. Pass an empty description to clear it. Use drive_rename for the " +
        `name. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          file_id: fileId,
          description: { type: "string", description: "New description (empty string clears it)" },
          properties: { type: "object", description: "Custom key/value properties to merge (null value deletes a key)" },
        },
        required: ["account", "file_id"],
      },
      handler: async (args: {
        account: string;
        file_id: string;
        description?: string;
        properties?: Record<string, string | null>;
      }) => {
        if (args.description === undefined && !args.properties) {
          throw new Error("drive_update_metadata needs description or properties");
        }
        const drive = await getClient(args.account);
        const res = await drive.files.update({
          fileId: args.file_id,
          requestBody: {
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.properties ? { properties: args.properties } : {}),
          },
          fields: `${fileFields},properties`,
          supportsAllDrives: true,
        } as never);
        return asText(res.data);
      },
    },
    {
      name: "drive_get_storage_quota",

      readOnly: true,
      description:
        "Storage quota and usage for the account (bytes): limit, usage, usageInDrive, " +
        "usageInDriveTrash, plus the signed-in user. limit is absent for unlimited plans. " +
        `${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: { account },
        required: ["account"],
      },
      handler: async (args: { account: string }) => {
        const drive = await getClient(args.account);
        const res = await drive.about.get({
          fields: "storageQuota(limit,usage,usageInDrive,usageInDriveTrash),user(displayName,emailAddress)",
        } as never);
        return asText(res.data);
      },
    },
  ];
}

export const driveTools = createDriveTools();
