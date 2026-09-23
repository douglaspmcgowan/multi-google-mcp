import type { docs_v1 } from "@googleapis/docs";
import { getAuthenticatedClient } from "../auth.js";
import { getAccountNames } from "../config.js";

type DocsClient = docs_v1.Docs;

async function getDocs(account: string): Promise<DocsClient> {
  const { docs } = await import("@googleapis/docs");
  return docs({ version: "v1", auth: getAuthenticatedClient(account) as never });
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

export interface DocOutlineEntry {
  startIndex: number;
  endIndex: number;
  style: string;
  text: string;
}

/**
 * Flattens `documents.get` into one line per paragraph.
 *
 * The raw response is a deep tree carrying every text run's styling, and a
 * document of any size will not fit in a model's context. What a caller
 * actually needs to write a batchUpdate is the index range of each paragraph
 * and enough of its text to recognize it, which is what this returns.
 */
export function summarizeDocument(doc: docs_v1.Schema$Document): DocOutlineEntry[] {
  const entries: DocOutlineEntry[] = [];
  for (const element of doc.body?.content ?? []) {
    const paragraph = element.paragraph;
    if (!paragraph) continue;
    const text = (paragraph.elements ?? [])
      .map((run) => run.textRun?.content ?? "")
      .join("")
      .replace(/\n+$/, "");
    entries.push({
      startIndex: element.startIndex ?? 0,
      endIndex: element.endIndex ?? 0,
      style: paragraph.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT",
      text,
    });
  }
  return entries;
}

export function createDocsTools(
  getClient: (account: string) => DocsClient | Promise<DocsClient> = getDocs,
  getAccounts: () => string[] = getAccountNames
) {
  const account = { type: "string" as const, description: "Account label" };
  const documentId = { type: "string" as const, description: "Google Doc file ID" };

  return [
    {
      name: "docs_get_structure",
      description:
        "Read a Google Doc as one entry per paragraph: its index range, named style and text. " +
        "This is what you read before docs_batch_update, because every index in a batchUpdate " +
        "request refers to the document as it was read. Re-read after any write rather than " +
        `reusing indices. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: { account, document_id: documentId },
        required: ["account", "document_id"],
      },
      handler: async (args: { account: string; document_id: string }) => {
        const docs = await getClient(args.account);
        const res = await docs.documents.get({ documentId: args.document_id } as never);
        return asText({
          documentId: res.data.documentId,
          title: res.data.title,
          paragraphs: summarizeDocument(res.data),
        });
      },
    },
    {
      name: "docs_replace_text",
      description:
        "Find and replace text across a Google Doc, leaving everything else untouched. This is " +
        "the safe way to revise a document other people are also editing — unlike " +
        `drive_update_content, which replaces the whole file. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          document_id: documentId,
          replacements: {
            type: "array" as const,
            description: "Find/replace pairs, applied in one atomic batch.",
            items: {
              type: "object" as const,
              properties: {
                find: { type: "string" as const, description: "Text to find" },
                replace: { type: "string" as const, description: "Text to put in its place" },
                match_case: { type: "boolean" as const, description: "Default true" },
              },
              required: ["find", "replace"],
            },
          },
        },
        required: ["account", "document_id", "replacements"],
      },
      handler: async (args: {
        account: string;
        document_id: string;
        replacements: Array<{ find: string; replace: string; match_case?: boolean }>;
      }) => {
        if (!args.replacements || args.replacements.length === 0) {
          throw new Error("replacements must contain at least one find/replace pair");
        }
        const docs = await getClient(args.account);
        const res = await docs.documents.batchUpdate({
          documentId: args.document_id,
          requestBody: {
            requests: args.replacements.map((pair) => ({
              replaceAllText: {
                containsText: { text: pair.find, matchCase: pair.match_case !== false },
                replaceText: pair.replace,
              },
            })),
          },
        } as never);
        return asText(res.data);
      },
    },
    {
      name: "docs_batch_update",
      description:
        "Apply raw Docs API requests to a Google Doc: insertText, deleteContentRange, " +
        "updateTextStyle, updateParagraphStyle, insertTable, insertInlineImage and the rest. " +
        "The whole batch is applied atomically — if one request is invalid, none of them land. " +
        `Read docs_get_structure first for the indices. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          document_id: documentId,
          requests: {
            type: "array" as const,
            description:
              "Docs API Request objects, e.g. [{\"insertText\":{\"location\":{\"index\":1}," +
              "\"text\":\"Hello\"}}].",
            items: { type: "object" as const },
          },
        },
        required: ["account", "document_id", "requests"],
      },
      handler: async (args: {
        account: string;
        document_id: string;
        requests: Record<string, unknown>[];
      }) => {
        if (!args.requests || args.requests.length === 0) {
          throw new Error("requests must contain at least one Docs API request");
        }
        const docs = await getClient(args.account);
        const res = await docs.documents.batchUpdate({
          documentId: args.document_id,
          requestBody: { requests: args.requests },
        } as never);
        return asText(res.data);
      },
    },
  ];
}

export const docsTools = createDocsTools();
