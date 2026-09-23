import type { docs_v1 } from "@googleapis/docs";
import { getAuthenticatedClient } from "../auth.js";
import { getAccountNames } from "../config.js";
import type { drive_v3 } from "@googleapis/drive";
import {
  bodyToMarkdown,
  headingsIn,
  parseMarkdown,
  type HeadingRef,
  type InlineRun,
} from "../markdown.js";

type DocsClient = docs_v1.Docs;
type Request = Record<string, unknown>;

async function getDriveClient(account: string): Promise<drive_v3.Drive> {
  const { drive } = await import("@googleapis/drive");
  return drive({ version: "v3", auth: getAuthenticatedClient(account) as never });
}

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
  /** Present only on list paragraphs. */
  bullet?: { listId: string; level: number };
}

/**
 * Flattens one body (the document's legacy `body`, or a tab's
 * `documentTab.body`) into one entry per paragraph.
 *
 * The raw response is a deep tree carrying every text run's styling, and a
 * document of any size will not fit in a model's context. What a caller
 * actually needs to write a batchUpdate is the index range of each paragraph
 * and enough of its text to recognize it, which is what this returns. A table
 * becomes one `TABLE` entry so the index gap it occupies is visible.
 */
export function summarizeBody(body: docs_v1.Schema$Body | undefined | null): DocOutlineEntry[] {
  const entries: DocOutlineEntry[] = [];
  for (const element of body?.content ?? []) {
    if (element.table) {
      entries.push({
        startIndex: element.startIndex ?? 0,
        endIndex: element.endIndex ?? 0,
        style: "TABLE",
        text: `[table ${element.table.rows ?? 0}x${element.table.columns ?? 0}]`,
      });
      continue;
    }
    const paragraph = element.paragraph;
    if (!paragraph) continue;
    const text = (paragraph.elements ?? [])
      .map((run) => run.textRun?.content ?? "")
      .join("")
      .replace(/\n+$/, "");
    const entry: DocOutlineEntry = {
      startIndex: element.startIndex ?? 0,
      endIndex: element.endIndex ?? 0,
      style: paragraph.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT",
      text,
    };
    if (paragraph.bullet) {
      entry.bullet = {
        listId: paragraph.bullet.listId ?? "",
        level: paragraph.bullet.nestingLevel ?? 0,
      };
    }
    entries.push(entry);
  }
  return entries;
}

/** The first tab's body, as `documents.get` returns it without includeTabsContent. */
export function summarizeDocument(doc: docs_v1.Schema$Document): DocOutlineEntry[] {
  return summarizeBody(doc.body);
}

export interface TabSummary {
  tabId: string;
  title: string;
  index: number;
  nestingLevel: number;
  parentTabId?: string;
  /** End index of the tab body; the last writable index is endIndex - 1. */
  endIndex: number;
  paragraphs?: DocOutlineEntry[];
}

/** Every tab in the document, depth-first (parent before its children). */
export function flattenTabs(doc: docs_v1.Schema$Document): docs_v1.Schema$Tab[] {
  const out: docs_v1.Schema$Tab[] = [];
  const walk = (tabs: docs_v1.Schema$Tab[] | undefined | null) => {
    for (const tab of tabs ?? []) {
      out.push(tab);
      walk(tab.childTabs);
    }
  };
  walk(doc.tabs);
  return out;
}

function bodyEndIndex(body: docs_v1.Schema$Body | undefined | null): number {
  const content = body?.content ?? [];
  return content.length ? content[content.length - 1].endIndex ?? 1 : 1;
}

export function summarizeTab(tab: docs_v1.Schema$Tab, withParagraphs = true): TabSummary {
  const props = tab.tabProperties ?? {};
  const body = tab.documentTab?.body;
  const summary: TabSummary = {
    tabId: props.tabId ?? "",
    title: props.title ?? "",
    index: props.index ?? 0,
    nestingLevel: props.nestingLevel ?? 0,
    endIndex: bodyEndIndex(body),
  };
  if (props.parentTabId) summary.parentTabId = props.parentTabId;
  if (withParagraphs) summary.paragraphs = summarizeBody(body);
  return summary;
}

function findTab(doc: docs_v1.Schema$Document, tabId: string): docs_v1.Schema$Tab {
  const tabs = flattenTabs(doc);
  const tab = tabs.find((candidate) => candidate.tabProperties?.tabId === tabId);
  if (!tab) {
    const known = tabs.map((t) => `${t.tabProperties?.tabId} (${t.tabProperties?.title})`);
    throw new Error(`tab ${tabId} not found; tabs in this document: ${known.join(", ") || "none"}`);
  }
  return tab;
}

/**
 * The `docs_get_structure` result. A single-tab document, or a request for one
 * tab, reads as before plus `tabId`/`tabTitle`; a multi-tab document returns
 * a flat `tabs` list, each with its own paragraphs and index space.
 */
export function structureOf(doc: docs_v1.Schema$Document, tabId?: string) {
  const head = { documentId: doc.documentId, title: doc.title };
  const tabs = flattenTabs(doc);
  if (tabs.length === 0) return { ...head, paragraphs: summarizeDocument(doc) };
  if (tabId || tabs.length === 1) {
    const tab = summarizeTab(tabId ? findTab(doc, tabId) : tabs[0]);
    return { ...head, tabId: tab.tabId, tabTitle: tab.title, paragraphs: tab.paragraphs };
  }
  return { ...head, tabs: tabs.map((tab) => summarizeTab(tab)) };
}

/** Keys whose value is a Location, EndOfSegmentLocation or Range, all of which carry `tabId`. */
const TAB_LOCATION_KEYS = new Set([
  "location",
  "endOfSegmentLocation",
  "tableStartLocation",
  "sectionBreakLocation",
  "range",
]);
/** Requests that take `tabId` directly on the request body. */
const TOP_LEVEL_TAB_REQUESTS = new Set([
  "replaceImage",
  "updateDocumentStyle",
  "deletePositionedObject",
  "deleteHeader",
  "deleteFooter",
  "updateNamedStyle",
]);
/** Requests that default to every tab and are scoped through `tabsCriteria`. */
const TABS_CRITERIA_REQUESTS = new Set(["replaceAllText", "replaceNamedRangeContent"]);
/** Tab-management requests name their tab themselves; never rewrite them. */
const TAB_MANAGEMENT_REQUESTS = new Set(["addDocumentTab", "deleteTab", "updateDocumentTabProperties"]);

function injectInto(value: unknown, tabId: string): void {
  if (Array.isArray(value)) {
    for (const item of value) injectInto(item, tabId);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (TAB_LOCATION_KEYS.has(key) && child && typeof child === "object" && !Array.isArray(child)) {
      const target = child as Record<string, unknown>;
      if (target.tabId == null || target.tabId === "") target.tabId = tabId;
    }
    injectInto(child, tabId);
  }
}

/**
 * Returns a copy of `requests` aimed at one tab. Without a tabId the Docs API
 * applies a request to the first tab (and replaceAllText to every tab), so a
 * batch meant for a second tab silently edits the first one.
 */
export function injectTabId(requests: Request[], tabId: string): Request[] {
  return requests.map((original) => {
    const request = structuredClone(original);
    for (const [kind, body] of Object.entries(request)) {
      if (!body || typeof body !== "object" || TAB_MANAGEMENT_REQUESTS.has(kind)) continue;
      const target = body as Record<string, unknown>;
      if (TOP_LEVEL_TAB_REQUESTS.has(kind) && (target.tabId == null || target.tabId === "")) {
        target.tabId = tabId;
      }
      if (TABS_CRITERIA_REQUESTS.has(kind) && target.tabsCriteria == null) {
        target.tabsCriteria = { tabIds: [tabId] };
      }
      injectInto(target, tabId);
    }
    return request;
  });
}

export const PARAGRAPH_STYLES = [
  "NORMAL_TEXT",
  "TITLE",
  "SUBTITLE",
  "HEADING_1",
  "HEADING_2",
  "HEADING_3",
  "HEADING_4",
  "HEADING_5",
  "HEADING_6",
] as const;

export interface WriteParagraph {
  text: string;
  style?: string;
  /** "bullet" or "numbered"; omit for a plain paragraph. */
  list?: string;
  /** List nesting level, 0-8. Ignored without `list`. */
  level?: number;
  /** Optional styled spans (UTF-16 offsets into `text`): bold, italic, code, link. */
  runs?: InlineRun[];
  /** Render the whole paragraph monospace (a code-block line). */
  code?: boolean;
}

const BULLET_PRESETS: Record<string, string> = {
  bullet: "BULLET_DISC_CIRCLE_SQUARE",
  numbered: "NUMBERED_DECIMAL_ALPHA_ROMAN",
};

const CODE_FONT = { fontFamily: "Courier New" };

function validateParagraphs(items: WriteParagraph[]): void {
  for (const [i, p] of items.entries()) {
    if (typeof p.text !== "string") throw new Error(`paragraph ${i} has no text`);
    if (p.text.includes("\n")) {
      throw new Error(`paragraph ${i} contains a newline; send each paragraph as its own entry`);
    }
    const style = p.style ?? "NORMAL_TEXT";
    if (!(PARAGRAPH_STYLES as readonly string[]).includes(style)) {
      throw new Error(`paragraph ${i} has unknown style ${style}; use one of ${PARAGRAPH_STYLES.join(", ")}`);
    }
    if (p.list !== undefined && !(p.list in BULLET_PRESETS)) {
      throw new Error(`paragraph ${i} has unknown list ${p.list}; use "bullet" or "numbered"`);
    }
    if (p.level !== undefined && (!Number.isInteger(p.level) || p.level < 0 || p.level > 8)) {
      throw new Error(`paragraph ${i} level must be an integer 0-8`);
    }
    for (const run of p.runs ?? []) {
      if (!(run.start >= 0 && run.end <= p.text.length && run.start < run.end)) {
        throw new Error(`paragraph ${i} has a run outside its text (${run.start}-${run.end})`);
      }
    }
  }
}

/**
 * Builds the requests that insert `paragraphs` at `insertAt` in one tab,
 * computing every index. `lead` is text inserted before the first paragraph
 * ("\n" when appending after a non-empty last paragraph).
 *
 * Order matters because a batch applies sequentially: insert all text, reset
 * inherited text style and bullets, set each paragraph's named style, apply
 * inline styles, then create lists last-group-first. List nesting comes from
 * leading tabs, which createParagraphBullets removes; doing the later groups
 * first keeps the earlier groups' indices valid, and inline styles are applied
 * before any tab is removed.
 */
function buildInsertRequests(
  tabId: string,
  insertAt: number,
  paragraphs: WriteParagraph[],
  lead = ""
): Request[] {
  const items: WriteParagraph[] = paragraphs.length ? paragraphs : [{ text: "" }];
  validateParagraphs(items);

  const prefixes = items.map((p) => (p.list ? "\t".repeat(p.level ?? 0) : ""));
  const texts = items.map((p, i) => prefixes[i] + p.text);
  const text = texts.join("\n");
  const first = insertAt + lead.length;
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = first;
  for (const t of texts) {
    ranges.push({ start: cursor, end: cursor + t.length + 1 });
    cursor += t.length + 1;
  }
  const allEnd = cursor;
  const range = (startIndex: number, endIndex: number) => ({ startIndex, endIndex, tabId });

  const requests: Request[] = [];
  if (lead.length + text.length) {
    requests.push({ insertText: { location: { index: insertAt, tabId }, text: lead + text } });
  }
  if (text.length) {
    requests.push({ updateTextStyle: { range: range(first, first + text.length), textStyle: {}, fields: "*" } });
  }
  requests.push({ deleteParagraphBullets: { range: range(first, allEnd) } });
  items.forEach((p, i) => {
    const plain = !p.list;
    requests.push({
      updateParagraphStyle: {
        range: range(ranges[i].start, ranges[i].end),
        paragraphStyle: plain
          ? {
              namedStyleType: p.style ?? "NORMAL_TEXT",
              indentStart: { magnitude: 0, unit: "PT" },
              indentFirstLine: { magnitude: 0, unit: "PT" },
            }
          : { namedStyleType: p.style ?? "NORMAL_TEXT" },
        fields: plain ? "namedStyleType,indentStart,indentFirstLine" : "namedStyleType",
      },
    });
  });

  items.forEach((p, i) => {
    const base = ranges[i].start + prefixes[i].length;
    if (p.code && p.text.length) {
      requests.push({
        updateTextStyle: {
          range: range(base, base + p.text.length),
          textStyle: { weightedFontFamily: CODE_FONT },
          fields: "weightedFontFamily",
        },
      });
    }
    for (const run of p.runs ?? []) {
      const textStyle: Record<string, unknown> = {};
      const fields: string[] = [];
      if (run.bold) {
        textStyle.bold = true;
        fields.push("bold");
      }
      if (run.italic) {
        textStyle.italic = true;
        fields.push("italic");
      }
      if (run.code) {
        textStyle.weightedFontFamily = CODE_FONT;
        fields.push("weightedFontFamily");
      }
      if (run.link) {
        textStyle.link = { url: run.link };
        fields.push("link");
      }
      if (!fields.length) continue;
      requests.push({
        updateTextStyle: { range: range(base + run.start, base + run.end), textStyle, fields: fields.join(",") },
      });
    }
  });

  const groups: Array<{ first: number; last: number; list: string }> = [];
  items.forEach((p, i) => {
    if (!p.list) return;
    const prev = groups[groups.length - 1];
    if (prev && prev.last === i - 1 && prev.list === p.list) prev.last = i;
    else groups.push({ first: i, last: i, list: p.list });
  });
  for (const group of groups.reverse()) {
    requests.push({
      createParagraphBullets: {
        range: range(ranges[group.first].start, ranges[group.last].end),
        bulletPreset: BULLET_PRESETS[group.list],
      },
    });
  }
  return requests;
}

/**
 * Builds the batch that replaces a tab body with `paragraphs`: clear the body
 * (the final newline cannot be deleted, so it becomes the last paragraph's
 * end), then insert at index 1.
 */
export function buildWriteTabRequests(
  tabId: string,
  bodyEnd: number,
  paragraphs: WriteParagraph[]
): Request[] {
  validateParagraphs(paragraphs);
  const requests: Request[] = [];
  if (bodyEnd - 1 > 1) {
    requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: bodyEnd - 1, tabId } } });
  }
  return requests.concat(buildInsertRequests(tabId, 1, paragraphs));
}

/**
 * Builds the batch that appends `paragraphs` after a tab's existing content
 * without touching it. An empty last paragraph is reused; otherwise a newline
 * is inserted first so the new text starts its own paragraph.
 */
export function buildAppendRequests(
  tabId: string,
  body: docs_v1.Schema$Body | undefined | null,
  paragraphs: WriteParagraph[]
): Request[] {
  if (!paragraphs.length) throw new Error("nothing to append");
  const content = body?.content ?? [];
  const end = bodyEndIndex(body);
  const last = content[content.length - 1];
  const lastText = (last?.paragraph?.elements ?? []).map((r) => r.textRun?.content ?? "").join("");
  const lastEmpty = !last?.paragraph || lastText === "\n" || lastText === "";
  return buildInsertRequests(tabId, end - 1, paragraphs, lastEmpty ? "" : "\n");
}

function localDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Paragraphs from either `markdown` or structured `paragraphs`, exactly one of which is given. */
function paragraphsFrom(args: { markdown?: string; paragraphs?: WriteParagraph[] }): WriteParagraph[] {
  if (args.markdown !== undefined && args.paragraphs !== undefined) {
    throw new Error("pass markdown or paragraphs, not both");
  }
  if (args.markdown !== undefined) return parseMarkdown(args.markdown);
  if (Array.isArray(args.paragraphs)) return args.paragraphs;
  throw new Error("pass markdown or paragraphs");
}

export function createDocsTools(
  getClient: (account: string) => DocsClient | Promise<DocsClient> = getDocs,
  getAccounts: () => string[] = getAccountNames,
  getDrive: (account: string) => drive_v3.Drive | Promise<drive_v3.Drive> = getDriveClient,
  now: () => Date = () => new Date()
) {
  const account = { type: "string" as const, description: "Account label" };
  const documentId = { type: "string" as const, description: "Google Doc file ID" };
  const tabIdProp = (description: string) => ({ type: "string" as const, description });

  async function getWithTabs(accountName: string, id: string) {
    const docs = await getClient(accountName);
    const res = await docs.documents.get({ documentId: id, includeTabsContent: true } as never);
    return { docs, doc: res.data as docs_v1.Schema$Document };
  }

  return [
    {
      name: "docs_get_structure",
      description:
        "Read a Google Doc as one entry per paragraph: its index range, named style, text, and " +
        "bullet {listId, level} for list items (tables appear as one TABLE entry). Reads every " +
        "tab: a single-tab doc (or tab_id given) returns tabId, tabTitle and paragraphs; a " +
        "multi-tab doc returns tabs[] with tabId, title, index, nestingLevel, parentTabId and " +
        "paragraphs each. Every tab has its own index space. This is what you read before " +
        "docs_batch_update, because every index refers to the document as it was read. Re-read " +
        `after any write rather than reusing indices. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          document_id: documentId,
          tab_id: tabIdProp("Optional: return only this tab (e.g. t.0)."),
        },
        required: ["account", "document_id"],
      },
      handler: async (args: { account: string; document_id: string; tab_id?: string }) => {
        const { doc } = await getWithTabs(args.account, args.document_id);
        return asText(structureOf(doc, args.tab_id || undefined));
      },
    },
    {
      name: "docs_list_tabs",
      description:
        "List a Google Doc's tabs, depth-first: tabId, title, index (within its parent), " +
        "nestingLevel, parentTabId and the tab body's endIndex. No paragraph text. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: { account, document_id: documentId },
        required: ["account", "document_id"],
      },
      handler: async (args: { account: string; document_id: string }) => {
        const { doc } = await getWithTabs(args.account, args.document_id);
        return asText({
          documentId: doc.documentId,
          title: doc.title,
          tabs: flattenTabs(doc).map((tab) => summarizeTab(tab, false)),
        });
      },
    },
    {
      name: "docs_add_tab",
      description:
        "Add a tab to a Google Doc (addDocumentTab). Returns the new tab's properties, " +
        `including its tabId. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          document_id: documentId,
          title: { type: "string" as const, description: "Tab title" },
          parent_tab_id: tabIdProp("Optional: nest the new tab under this tab."),
          index: { type: "number" as const, description: "Optional zero-based position within the parent" },
        },
        required: ["account", "document_id", "title"],
      },
      handler: async (args: {
        account: string;
        document_id: string;
        title: string;
        parent_tab_id?: string;
        index?: number;
      }) => {
        const tabProperties: Record<string, unknown> = { title: args.title };
        if (args.parent_tab_id) tabProperties.parentTabId = args.parent_tab_id;
        if (args.index !== undefined) tabProperties.index = args.index;
        const docs = await getClient(args.account);
        const res = await docs.documents.batchUpdate({
          documentId: args.document_id,
          requestBody: { requests: [{ addDocumentTab: { tabProperties } }] },
        } as never);
        const reply = (res.data as docs_v1.Schema$BatchUpdateDocumentResponse).replies?.[0];
        return asText({ documentId: args.document_id, tab: reply?.addDocumentTab?.tabProperties ?? null });
      },
    },
    {
      name: "docs_rename_tab",
      description:
        "Rename a tab in a Google Doc (updateDocumentTabProperties, fields=title). " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          document_id: documentId,
          tab_id: tabIdProp("Tab to rename"),
          title: { type: "string" as const, description: "New title" },
        },
        required: ["account", "document_id", "tab_id", "title"],
      },
      handler: async (args: { account: string; document_id: string; tab_id: string; title: string }) => {
        const docs = await getClient(args.account);
        const res = await docs.documents.batchUpdate({
          documentId: args.document_id,
          requestBody: {
            requests: [
              {
                updateDocumentTabProperties: {
                  tabProperties: { tabId: args.tab_id, title: args.title },
                  fields: "title",
                },
              },
            ],
          },
        } as never);
        return asText(res.data);
      },
    },
    {
      name: "docs_delete_tab",
      description:
        "Delete one tab from a Google Doc (deleteTab). Its content is recoverable only through " +
        "version history. confirm_title must equal the tab's current title, a tab with child " +
        "tabs needs include_children=true (they are deleted with it), and the last remaining " +
        `tab cannot be deleted. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          document_id: documentId,
          tab_id: tabIdProp("Tab to delete"),
          confirm_title: { type: "string" as const, description: "The tab's current title, exactly" },
          include_children: { type: "boolean" as const, description: "Required when the tab has child tabs" },
        },
        required: ["account", "document_id", "tab_id", "confirm_title"],
      },
      handler: async (args: {
        account: string;
        document_id: string;
        tab_id: string;
        confirm_title: string;
        include_children?: boolean;
      }) => {
        const { docs, doc } = await getWithTabs(args.account, args.document_id);
        const tab = findTab(doc, args.tab_id);
        const title = tab.tabProperties?.title ?? "";
        if (title !== args.confirm_title) {
          throw new Error(`confirm_title "${args.confirm_title}" does not match tab title "${title}"`);
        }
        if ((tab.childTabs?.length ?? 0) > 0 && !args.include_children) {
          throw new Error(`tab ${args.tab_id} has child tabs; pass include_children=true to delete them too`);
        }
        const remaining = (doc.tabs ?? []).filter((t) => t.tabProperties?.tabId !== args.tab_id);
        if (remaining.length === 0) throw new Error("refusing to delete the document's only top-level tab");
        const res = await docs.documents.batchUpdate({
          documentId: args.document_id,
          requestBody: { requests: [{ deleteTab: { tabId: args.tab_id } }] },
        } as never);
        return asText({ deleted: { tabId: args.tab_id, title }, replies: res.data.replies ?? [] });
      },
    },
    {
      name: "docs_write_tab",
      description:
        "Replace the entire body of one tab with structured paragraphs, computing every index " +
        "itself: each paragraph is {text, style?, list?, level?} where style is NORMAL_TEXT, " +
        "TITLE, SUBTITLE or HEADING_1..6, list is \"bullet\" or \"numbered\", and level (0-8) " +
        "nests list items. Headers and footers are untouched; everything else in the tab body " +
        "(including tables and images) is removed. Use it on tabs this session owns; for a tab " +
        "others edit, use docs_replace_text or docs_batch_update. Text may not contain newlines " +
        `— send one entry per paragraph. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          document_id: documentId,
          tab_id: tabIdProp("Tab to overwrite (from docs_list_tabs; the first tab is usually t.0)"),
          paragraphs: {
            type: "array" as const,
            description: "Paragraphs in order",
            items: {
              type: "object" as const,
              properties: {
                text: { type: "string" as const, description: "Paragraph text, no newlines" },
                style: { type: "string" as const, description: "NORMAL_TEXT (default), TITLE, SUBTITLE, HEADING_1..6" },
                list: { type: "string" as const, description: "Optional: bullet or numbered" },
                level: { type: "number" as const, description: "List nesting level 0-8 (default 0)" },
              },
              required: ["text"],
            },
          },
        },
        required: ["account", "document_id", "tab_id", "paragraphs"],
      },
      handler: async (args: {
        account: string;
        document_id: string;
        tab_id: string;
        paragraphs: WriteParagraph[];
      }) => {
        if (!Array.isArray(args.paragraphs)) throw new Error("paragraphs must be an array");
        const { docs, doc } = await getWithTabs(args.account, args.document_id);
        const tab = findTab(doc, args.tab_id);
        const requests = buildWriteTabRequests(
          args.tab_id,
          bodyEndIndex(tab.documentTab?.body),
          args.paragraphs
        );
        await docs.documents.batchUpdate({
          documentId: args.document_id,
          requestBody: { requests },
        } as never);
        return asText({
          documentId: args.document_id,
          tabId: args.tab_id,
          paragraphsWritten: args.paragraphs.length,
          requestsSent: requests.length,
        });
      },
    },
    {
      name: "docs_write_markdown",
      description:
        "Write markdown into a Google Doc as real formatting: # headings (HEADING_1..6), - / * " +
        "bullets and 1. numbered lists (nesting by indentation), **bold**, *italic*, `code`, " +
        "[links](url), ``` fenced code (monospace lines) and > quotes (italic). Two modes: give " +
        "document_id + tab_id to REPLACE that tab's whole body (like docs_write_tab), or give " +
        "title (and optional parent_id folder) to CREATE a new Doc. Tables become plain text " +
        `lines. To add to a tab without rewriting it, use docs_append_to_tab. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          markdown: { type: "string" as const, description: "Markdown source" },
          document_id: { type: "string" as const, description: "Existing Doc to write into (replace mode; needs tab_id)" },
          tab_id: tabIdProp("Tab whose body is replaced (replace mode)"),
          title: { type: "string" as const, description: "Title of a new Doc (create mode)" },
          parent_id: { type: "string" as const, description: "Optional Drive folder for the new Doc (create mode)" },
        },
        required: ["account", "markdown"],
      },
      handler: async (args: {
        account: string;
        markdown: string;
        document_id?: string;
        tab_id?: string;
        title?: string;
        parent_id?: string;
      }) => {
        const paragraphs = parseMarkdown(args.markdown);
        let documentId = args.document_id;
        let created = false;
        if (documentId) {
          if (!args.tab_id) throw new Error("replace mode needs tab_id (see docs_list_tabs; the first tab is usually t.0)");
          if (args.title || args.parent_id) throw new Error("title/parent_id apply only when creating; omit document_id to create");
        } else {
          if (!args.title) throw new Error("pass document_id + tab_id to replace a tab, or title to create a new Doc");
          if (args.parent_id) {
            const drive = await getDrive(args.account);
            const res = await drive.files.create({
              requestBody: {
                name: args.title,
                mimeType: "application/vnd.google-apps.document",
                parents: [args.parent_id],
              },
              fields: "id",
              supportsAllDrives: true,
            } as never);
            documentId = (res.data as { id?: string }).id ?? undefined;
          } else {
            const docs = await getClient(args.account);
            const res = await docs.documents.create({ requestBody: { title: args.title } } as never);
            documentId = (res.data as docs_v1.Schema$Document).documentId ?? undefined;
          }
          if (!documentId) throw new Error("Google did not return the new document's id");
          created = true;
        }
        const { docs, doc } = await getWithTabs(args.account, documentId);
        const tab = args.tab_id ? findTab(doc, args.tab_id) : flattenTabs(doc)[0];
        const tabId = tab?.tabProperties?.tabId ?? args.tab_id ?? "t.0";
        const requests = buildWriteTabRequests(tabId, bodyEndIndex(tab?.documentTab?.body ?? doc.body), paragraphs);
        await docs.documents.batchUpdate({ documentId, requestBody: { requests } } as never);
        return asText({
          documentId,
          tabId,
          created,
          url: `https://docs.google.com/document/d/${documentId}/edit?tab=${tabId}`,
          paragraphsWritten: paragraphs.length,
          requestsSent: requests.length,
        });
      },
    },
    {
      name: "docs_append_to_tab",
      description:
        "Append a section to the END of one tab without rewriting or re-indexing what is " +
        "already there — the safe way to add a log entry, meeting note or dated update to a " +
        "shared tab. Content is markdown (same subset as docs_write_markdown) or structured " +
        "paragraphs ({text, style?, list?, level?}). Optional heading is added first " +
        "(heading_style default HEADING_2); date_prefix=true prefixes it with today's date " +
        `(YYYY-MM-DD). ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          document_id: documentId,
          tab_id: tabIdProp("Tab to append to (from docs_list_tabs; the first tab is usually t.0)"),
          markdown: { type: "string" as const, description: "Markdown to append (or use paragraphs)" },
          paragraphs: {
            type: "array" as const,
            description: "Structured paragraphs to append (or use markdown)",
            items: {
              type: "object" as const,
              properties: {
                text: { type: "string" as const, description: "Paragraph text, no newlines" },
                style: { type: "string" as const, description: "NORMAL_TEXT (default), TITLE, SUBTITLE, HEADING_1..6" },
                list: { type: "string" as const, description: "Optional: bullet or numbered" },
                level: { type: "number" as const, description: "List nesting level 0-8 (default 0)" },
              },
              required: ["text"],
            },
          },
          heading: { type: "string" as const, description: "Optional heading placed before the content" },
          heading_style: { type: "string" as const, description: "Style for heading (default HEADING_2)" },
          date_prefix: { type: "boolean" as const, description: "Prefix the heading (or a new heading) with today's date" },
        },
        required: ["account", "document_id", "tab_id"],
      },
      handler: async (args: {
        account: string;
        document_id: string;
        tab_id: string;
        markdown?: string;
        paragraphs?: WriteParagraph[];
        heading?: string;
        heading_style?: string;
        date_prefix?: boolean;
      }) => {
        const content = paragraphsFrom(args);
        const heading =
          args.date_prefix
            ? args.heading
              ? `${localDate(now())} — ${args.heading}`
              : localDate(now())
            : args.heading;
        const paragraphs: WriteParagraph[] = heading
          ? [{ text: heading, style: args.heading_style ?? "HEADING_2" }, ...content]
          : content;
        const { docs, doc } = await getWithTabs(args.account, args.document_id);
        const tab = findTab(doc, args.tab_id);
        const requests = buildAppendRequests(args.tab_id, tab.documentTab?.body, paragraphs);
        await docs.documents.batchUpdate({ documentId: args.document_id, requestBody: { requests } } as never);
        return asText({
          documentId: args.document_id,
          tabId: args.tab_id,
          appendedAt: bodyEndIndex(tab.documentTab?.body) - 1,
          paragraphsAppended: paragraphs.length,
          requestsSent: requests.length,
        });
      },
    },
    {
      name: "docs_read_markdown",
      description:
        "Read a Google Doc — or one tab — back as compact markdown: headings, nested bullet and " +
        "numbered lists, bold, italic, code (monospace), links and tables. Far smaller than " +
        "docs_get_structure; use it to read content, and docs_get_structure when you need " +
        "indices. Without tab_id a multi-tab doc returns every tab, each introduced by a " +
        `'<!-- tab t.x: Title -->' line. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          document_id: documentId,
          tab_id: tabIdProp("Optional: read only this tab"),
        },
        required: ["account", "document_id"],
      },
      handler: async (args: { account: string; document_id: string; tab_id?: string }) => {
        const { doc } = await getWithTabs(args.account, args.document_id);
        const tabs = flattenTabs(doc);
        let text: string;
        if (tabs.length === 0) {
          text = bodyToMarkdown(doc.body, doc.lists);
        } else if (args.tab_id || tabs.length === 1) {
          const tab = args.tab_id ? findTab(doc, args.tab_id) : tabs[0];
          text = bodyToMarkdown(tab.documentTab?.body, tab.documentTab?.lists);
        } else {
          text = tabs
            .map((tab) => {
              const p = tab.tabProperties ?? {};
              return `<!-- tab ${p.tabId}: ${p.title ?? ""} -->\n\n${bodyToMarkdown(tab.documentTab?.body, tab.documentTab?.lists)}`;
            })
            .join("\n");
        }
        return { content: [{ type: "text" as const, text: text || "(empty)" }] };
      },
    },
    {
      name: "docs_heading_link",
      description:
        "Return a URL that deep-links to a heading in a Google Doc " +
        "(https://docs.google.com/document/d/<id>/edit?tab=<tabId>#heading=h.xxx). Match by " +
        "heading text (case-insensitive; exact match wins over substring) or heading_id; omit " +
        "both to list every heading's link. Searches every tab unless tab_id is given. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          document_id: documentId,
          heading: { type: "string" as const, description: "Heading text to find" },
          heading_id: { type: "string" as const, description: "Exact heading id, e.g. h.abc123" },
          tab_id: tabIdProp("Optional: search only this tab"),
        },
        required: ["account", "document_id"],
      },
      handler: async (args: {
        account: string;
        document_id: string;
        heading?: string;
        heading_id?: string;
        tab_id?: string;
      }) => {
        const { doc } = await getWithTabs(args.account, args.document_id);
        const id = doc.documentId ?? args.document_id;
        const tabs = args.tab_id ? [findTab(doc, args.tab_id)] : flattenTabs(doc);
        const all: HeadingRef[] = tabs.length
          ? tabs.flatMap((tab) =>
              headingsIn(id, tab.documentTab?.body, tab.tabProperties?.tabId ?? "", tab.tabProperties?.title ?? "")
            )
          : headingsIn(id, doc.body, "", "");
        if (!args.heading && !args.heading_id) return asText({ documentId: id, headings: all });
        let matches: HeadingRef[];
        if (args.heading_id) {
          matches = all.filter((h) => h.headingId === args.heading_id);
        } else {
          const wanted = args.heading!.trim().toLowerCase();
          const exact = all.filter((h) => h.text.toLowerCase() === wanted);
          matches = exact.length ? exact : all.filter((h) => h.text.toLowerCase().includes(wanted));
        }
        if (!matches.length) {
          const known = all.slice(0, 40).map((h) => `${h.tabId}: ${h.text}`);
          throw new Error(
            `no heading matches ${JSON.stringify(args.heading_id ?? args.heading)}; headings: ${known.join(" | ") || "none"}`
          );
        }
        return asText(matches.length === 1 ? matches[0] : { documentId: id, matches });
      },
    },
    {
      name: "docs_replace_text",
      description:
        "Find and replace text across a Google Doc, leaving everything else untouched. This is " +
        "the safe way to revise a document other people are also editing — unlike " +
        "drive_update_content, which replaces the whole file. Applies to every tab unless " +
        `tab_id is given. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          document_id: documentId,
          tab_id: tabIdProp("Optional: only replace within this tab"),
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
        tab_id?: string;
        replacements: Array<{ find: string; replace: string; match_case?: boolean }>;
      }) => {
        if (!args.replacements || args.replacements.length === 0) {
          throw new Error("replacements must contain at least one find/replace pair");
        }
        let requests: Request[] = args.replacements.map((pair) => ({
          replaceAllText: {
            containsText: { text: pair.find, matchCase: pair.match_case !== false },
            replaceText: pair.replace,
          },
        }));
        if (args.tab_id) requests = injectTabId(requests, args.tab_id);
        const docs = await getClient(args.account);
        const res = await docs.documents.batchUpdate({
          documentId: args.document_id,
          requestBody: { requests },
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
        "Without a tabId a request edits the FIRST tab. Pass tab_id to aim the batch at one " +
        "tab: it is added to every location, endOfSegmentLocation, tableStartLocation, " +
        "sectionBreakLocation and range lacking a tabId, to the tabId of replaceImage, " +
        "updateDocumentStyle, deletePositionedObject, deleteHeader, deleteFooter and " +
        "updateNamedStyle, and as tabsCriteria on replaceAllText/replaceNamedRangeContent; " +
        "an explicit tabId is never overwritten and tab-management requests are left alone. " +
        `Read docs_get_structure first for the indices. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          document_id: documentId,
          tab_id: tabIdProp("Optional: tab every request applies to (see description)"),
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
        tab_id?: string;
        requests: Request[];
      }) => {
        if (!args.requests || args.requests.length === 0) {
          throw new Error("requests must contain at least one Docs API request");
        }
        const requests = args.tab_id ? injectTabId(args.requests, args.tab_id) : args.requests;
        const docs = await getClient(args.account);
        const res = await docs.documents.batchUpdate({
          documentId: args.document_id,
          requestBody: { requests },
        } as never);
        return asText(res.data);
      },
    },
  ];
}

export const docsTools = createDocsTools();
