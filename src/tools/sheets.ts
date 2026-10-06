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

      readOnly: true,
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

      readOnly: true,
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

      readOnly: false,
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

      readOnly: false,
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

      readOnly: false,
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
    {
      name: "sheets_clear_range",

      readOnly: false,
      description:
        "Clear the values in a range (A1 notation or a whole tab name), keeping formatting, " +
        "validation and the cells themselves. Destructive for the values: they are gone unless " +
        `Drive version history has them. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: { account, spreadsheet_id: spreadsheetId, range },
        required: ["account", "spreadsheet_id", "range"],
      },
      handler: async (args: { account: string; spreadsheet_id: string; range: string }) => {
        const sheets = await getClient(args.account);
        const res = await sheets.spreadsheets.values.clear({
          spreadsheetId: args.spreadsheet_id,
          range: args.range,
          requestBody: {},
        } as never);
        return asText(res.data);
      },
    },
    {
      name: "sheets_create",

      readOnly: false,
      description:
        "Create a native Google Sheet with named tabs in one call (drive_create with mime_type " +
        "sheet makes one default tab only). Lands in My Drive root; move it with drive_move. " +
        `Returns spreadsheetId, URL and each tab's sheetId. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          title: { type: "string" as const, description: "Spreadsheet title" },
          tabs: {
            type: "array" as const,
            description: "Tab names in order (default: one tab, Sheet1)",
            items: { type: "string" as const },
          },
        },
        required: ["account", "title"],
      },
      handler: async (args: { account: string; title: string; tabs?: string[] }) => {
        const sheets = await getClient(args.account);
        const tabs = (args.tabs ?? []).map((t) => t.trim()).filter(Boolean);
        const res = await sheets.spreadsheets.create({
          requestBody: {
            properties: { title: args.title },
            ...(tabs.length ? { sheets: tabs.map((title) => ({ properties: { title } })) } : {}),
          },
          fields: "spreadsheetId,spreadsheetUrl,sheets.properties",
        } as never);
        return asText({
          spreadsheetId: res.data.spreadsheetId,
          url: res.data.spreadsheetUrl,
          sheets: (res.data.sheets ?? []).map((sheet) => sheet.properties),
        });
      },
    },
    {
      name: "sheets_add_tab",

      readOnly: false,
      description:
        "Add a tab (sheet) to a spreadsheet, optionally at a position and with a size. Returns " +
        `the new tab's sheetId. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          spreadsheet_id: spreadsheetId,
          title: { type: "string" as const, description: "Tab name" },
          index: { type: "number" as const, description: "Zero-based position (default: end)" },
          rows: { type: "number" as const, description: "Row count (default 1000)" },
          columns: { type: "number" as const, description: "Column count (default 26)" },
        },
        required: ["account", "spreadsheet_id", "title"],
      },
      handler: async (args: {
        account: string;
        spreadsheet_id: string;
        title: string;
        index?: number;
        rows?: number;
        columns?: number;
      }) => {
        if (!args.title?.trim()) throw new Error("title is required");
        const sheets = await getClient(args.account);
        const grid: Record<string, number> = {};
        if (args.rows !== undefined) grid.rowCount = args.rows;
        if (args.columns !== undefined) grid.columnCount = args.columns;
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId: args.spreadsheet_id,
          requestBody: {
            requests: [
              {
                addSheet: {
                  properties: {
                    title: args.title,
                    ...(args.index !== undefined ? { index: args.index } : {}),
                    ...(Object.keys(grid).length ? { gridProperties: grid } : {}),
                  },
                },
              },
            ],
          },
        } as never);
        const added = (res.data.replies ?? [])[0]?.addSheet?.properties;
        return asText({ spreadsheetId: args.spreadsheet_id, sheet: added });
      },
    },
    {
      name: "sheets_rename_tab",

      readOnly: false,
      description:
        "Rename a tab. Formulas that refer to the tab by name are updated by Sheets. Get the " +
        `sheetId from sheets_get_structure. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          spreadsheet_id: spreadsheetId,
          sheet_id: { type: "number" as const, description: "Tab sheetId from sheets_get_structure" },
          title: { type: "string" as const, description: "New tab name" },
        },
        required: ["account", "spreadsheet_id", "sheet_id", "title"],
      },
      handler: async (args: { account: string; spreadsheet_id: string; sheet_id: number; title: string }) => {
        if (!args.title?.trim()) throw new Error("title is required");
        const sheets = await getClient(args.account);
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId: args.spreadsheet_id,
          requestBody: {
            requests: [
              { updateSheetProperties: { properties: { sheetId: args.sheet_id, title: args.title }, fields: "title" } },
            ],
          },
        } as never);
        return asText(res.data);
      },
    },
    {
      name: "sheets_delete_tab",

      readOnly: false,
      description:
        "DESTRUCTIVE: delete a tab and all its data. References to it in formulas become #REF!. " +
        "Recoverable only from Drive version history. Get the sheetId from sheets_get_structure; " +
        `a spreadsheet's last tab cannot be deleted. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          spreadsheet_id: spreadsheetId,
          sheet_id: { type: "number" as const, description: "Tab sheetId from sheets_get_structure" },
        },
        required: ["account", "spreadsheet_id", "sheet_id"],
      },
      handler: async (args: { account: string; spreadsheet_id: string; sheet_id: number }) => {
        const sheets = await getClient(args.account);
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId: args.spreadsheet_id,
          requestBody: { requests: [{ deleteSheet: { sheetId: args.sheet_id } }] },
        } as never);
        return asText({ spreadsheetId: args.spreadsheet_id, sheetId: args.sheet_id, deleted: true, replies: res.data.replies });
      },
    },
    {
      name: "sheets_find",

      readOnly: true,
      description:
        "Search the cell values of a range or whole tab for text and return the matching cells " +
        "with their A1 address and value. Case-insensitive substring by default; exact=true " +
        "matches whole cell values. Reads displayed values. " +
        `${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          spreadsheet_id: spreadsheetId,
          range,
          query: { type: "string" as const, description: "Text to look for" },
          match_case: { type: "boolean" as const, description: "Case-sensitive (default false)" },
          exact: { type: "boolean" as const, description: "Whole-cell match (default false)" },
          max_results: { type: "number" as const, description: "Maximum matches (default 100)" },
        },
        required: ["account", "spreadsheet_id", "range", "query"],
      },
      handler: async (args: {
        account: string;
        spreadsheet_id: string;
        range: string;
        query: string;
        match_case?: boolean;
        exact?: boolean;
        max_results?: number;
      }) => {
        if (!args.query) throw new Error("query is required");
        const sheets = await getClient(args.account);
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: args.spreadsheet_id,
          range: args.range,
        } as never);
        const data = res.data as { range?: string; values?: unknown[][] };
        const start = parseStartCell(data.range ?? args.range);
        const needle = args.match_case ? args.query : args.query.toLowerCase();
        const limit = args.max_results ?? 100;
        const matches: Array<{ cell: string; value: string }> = [];
        const rows = data.values ?? [];
        for (let r = 0; r < rows.length && matches.length < limit; r++) {
          for (let c = 0; c < rows[r].length && matches.length < limit; c++) {
            const value = String(rows[r][c] ?? "");
            const hay = args.match_case ? value : value.toLowerCase();
            if (args.exact ? hay === needle : hay.includes(needle)) {
              matches.push({ cell: `${columnName(start.col + c)}${start.row + r}`, value });
            }
          }
        }
        return asText({ spreadsheetId: args.spreadsheet_id, range: data.range ?? args.range, count: matches.length, matches });
      },
    },
  ];
}

/** 0-based column index to A1 letters. */
export function columnName(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** First cell of a returned range such as "Tab'!B3:D9" as a 0-based column and 1-based row (A1 when absent). */
export function parseStartCell(range: string): { col: number; row: number } {
  const cells = range.includes("!") ? range.slice(range.lastIndexOf("!") + 1) : range;
  const m = /^\$?([A-Za-z]{1,3})?\$?(\d+)?$/.exec(cells.split(":")[0]);
  if (!m || (!m[1] && !m[2])) return { col: 0, row: 1 };
  const letters = m?.[1]?.toUpperCase();
  const col = letters ? [...letters].reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1 : 0;
  return { col, row: m?.[2] ? Number(m[2]) : 1 };
}

export const sheetsTools = createSheetsTools();
