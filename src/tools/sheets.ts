import type { sheets_v4 } from "@googleapis/sheets";
import { getAuthenticatedClient } from "../auth.js";
import { getAccountNames } from "../config.js";

type SheetsClient = sheets_v4.Sheets;

async function getSheets(account: string): Promise<SheetsClient> {
  const { sheets } = await import("@googleapis/sheets");
  return sheets({ version: "v4", auth: getAuthenticatedClient(account) as never });
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

function asText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function createSheetsTools(
  getClient: (account: string) => SheetsClient | Promise<SheetsClient> = getSheets,
  getAccounts: () => string[] = getAccountNames
) {
  const account = { type: "string" as const, description: "Account label" };
  const spreadsheetId = { type: "string" as const, description: "Google Sheet file ID" };
  const range = {
    type: "string" as const,
    description: "A1 notation, e.g. 'Sheet1!A1:D20' or a whole tab name.",
  };
  const values = {
    type: "array" as const,
    description: "Rows of cell values.",
    items: { type: "array" as const, items: {} },
  };

  return [
    {
      name: "sheets_get_structure",
      description:
        "List a spreadsheet's tabs with their sheet IDs, titles and dimensions. The sheet IDs are " +
        `what sheets_batch_update edits against. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: { account, spreadsheet_id: spreadsheetId },
        required: ["account", "spreadsheet_id"],
      },
      handler: async (args: { account: string; spreadsheet_id: string }) => {
        const sheets = await getClient(args.account);
        const res = await sheets.spreadsheets.get({
          spreadsheetId: args.spreadsheet_id,
          fields: "spreadsheetId,properties.title,sheets.properties",
        } as never);
        return asText({
          spreadsheetId: res.data.spreadsheetId,
          title: res.data.properties?.title,
          sheets: (res.data.sheets ?? []).map((sheet) => sheet.properties),
        });
      },
    },
    {
      name: "sheets_read_range",
      description:
        "Read cell values from a range. Reading a sheet this way returns every row — unlike a " +
        "plain-text Drive export of a spreadsheet, which silently truncates. " +
        `${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: { account, spreadsheet_id: spreadsheetId, range },
        required: ["account", "spreadsheet_id", "range"],
      },
      handler: async (args: { account: string; spreadsheet_id: string; range: string }) => {
        const sheets = await getClient(args.account);
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: args.spreadsheet_id,
          range: args.range,
        } as never);
        return asText(res.data);
      },
    },
    {
      name: "sheets_write_range",
      description:
        "Overwrite the cells in a range with the supplied rows. Only the range given is touched. " +
        `${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          spreadsheet_id: spreadsheetId,
          range,
          values,
          raw: {
            type: "boolean" as const,
            description:
              "True stores values exactly as given. Default false, which parses them the way " +
              "typing into the UI would, so '=SUM(A1:A2)' becomes a formula and '1/2' a date.",
          },
        },
        required: ["account", "spreadsheet_id", "range", "values"],
      },
      handler: async (args: {
        account: string;
        spreadsheet_id: string;
        range: string;
        values: unknown[][];
        raw?: boolean;
      }) => {
        const sheets = await getClient(args.account);
        const res = await sheets.spreadsheets.values.update({
          spreadsheetId: args.spreadsheet_id,
          range: args.range,
          valueInputOption: args.raw ? "RAW" : "USER_ENTERED",
          requestBody: { values: args.values },
        } as never);
        return asText(res.data);
      },
    },
    {
      name: "sheets_append_rows",
      description:
        "Append rows after the last row with data in a range, leaving existing rows alone. " +
        `${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          spreadsheet_id: spreadsheetId,
          range,
          values,
          raw: { type: "boolean" as const, description: "See sheets_write_range. Default false." },
        },
        required: ["account", "spreadsheet_id", "range", "values"],
      },
      handler: async (args: {
        account: string;
        spreadsheet_id: string;
        range: string;
        values: unknown[][];
        raw?: boolean;
      }) => {
        const sheets = await getClient(args.account);
        const res = await sheets.spreadsheets.values.append({
          spreadsheetId: args.spreadsheet_id,
          range: args.range,
          valueInputOption: args.raw ? "RAW" : "USER_ENTERED",
          insertDataOption: "INSERT_ROWS",
          requestBody: { values: args.values },
        } as never);
        return asText(res.data);
      },
    },
    {
      name: "sheets_batch_update",
      description:
        "Apply raw Sheets API requests for structure rather than values: addSheet, " +
        "repeatCell and formatting, updateSheetProperties for frozen rows, conditional formats, " +
        "charts. The whole batch is applied atomically. Read sheets_get_structure first for the " +
        `sheet IDs. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          spreadsheet_id: spreadsheetId,
          requests: {
            type: "array" as const,
            description: "Sheets API Request objects.",
            items: { type: "object" as const },
          },
        },
        required: ["account", "spreadsheet_id", "requests"],
      },
      handler: async (args: {
        account: string;
        spreadsheet_id: string;
        requests: Record<string, unknown>[];
      }) => {
        if (!args.requests || args.requests.length === 0) {
          throw new Error("requests must contain at least one Sheets API request");
        }
        const sheets = await getClient(args.account);
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId: args.spreadsheet_id,
          requestBody: { requests: args.requests },
        } as never);
        return asText(res.data);
      },
    },
  ];
}

export const sheetsTools = createSheetsTools();
