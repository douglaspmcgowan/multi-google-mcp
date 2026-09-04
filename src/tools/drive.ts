import { google } from "googleapis";
import { getAuthenticatedClient } from "../auth.js";
import { getAccountNames } from "../config.js";

type DriveClient = ReturnType<typeof google.drive>;

function getDrive(account: string): DriveClient {
  return google.drive({ version: "v3", auth: getAuthenticatedClient(account) });
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

export function createDriveTools(
  getClient: (account: string) => DriveClient = getDrive,
  getAccounts: () => string[] = getAccountNames
) {
  return [
    {
      name: "drive_search",
      description: `Search files in a specific Google Drive account. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account: { type: "string", description: "Account label" },
          query: { type: "string", description: "Drive query syntax" },
          max_results: { type: "number", description: "Max files to return (default 10)" },
        },
        required: ["account", "query"],
      },
      handler: async (args: { account: string; query: string; max_results?: number }) => {
        const drive = getClient(args.account);
        const res = await drive.files.list({
          q: args.query,
          pageSize: args.max_results || 10,
          fields: `files(${fileFields})`,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(res.data.files || [], null, 2) }] };
      },
    },
    {
      name: "drive_get_metadata",
      description: `Get metadata for a Drive file. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: { account: { type: "string", description: "Account label" }, file_id: { type: "string", description: "Drive file ID" } },
        required: ["account", "file_id"],
      },
      handler: async (args: { account: string; file_id: string }) => {
        const drive = getClient(args.account);
        const res = await drive.files.get({ fileId: args.file_id, fields: fileFields });
        return { content: [{ type: "text" as const, text: JSON.stringify(res.data, null, 2) }] };
      },
    },
    {
      name: "drive_get_permissions",
      description: `List permissions for a Drive file. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: { account: { type: "string", description: "Account label" }, file_id: { type: "string", description: "Drive file ID" } },
        required: ["account", "file_id"],
      },
      handler: async (args: { account: string; file_id: string }) => {
        const drive = getClient(args.account);
        const res = await drive.permissions.list({ fileId: args.file_id, fields: permissionFields });
        return { content: [{ type: "text" as const, text: JSON.stringify(res.data.permissions || [], null, 2) }] };
      },
    },
    {
      name: "drive_share",
      description: `Share a Drive file with a user. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account: { type: "string", description: "Account label" },
          file_id: { type: "string", description: "Drive file ID" },
          email: { type: "string", description: "Recipient email address" },
          role: { type: "string", description: "Permission role (reader, commenter, or writer)" },
        },
        required: ["account", "file_id", "email", "role"],
      },
      handler: async (args: { account: string; file_id: string; email: string; role: string }) => {
        const drive = getClient(args.account);
        const res = await drive.permissions.create({
          fileId: args.file_id,
          sendNotificationEmail: true,
          requestBody: { type: "user", role: args.role, emailAddress: args.email },
          fields: "id",
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ fileId: args.file_id, email: args.email, role: args.role, permissionId: res.data.id }, null, 2) }],
        };
      },
    },
  ];
}

export const driveTools = createDriveTools();
