import type { docs_v1 } from "@googleapis/docs";

/** One styled span inside a paragraph, as UTF-16 offsets into the paragraph text. */
export interface InlineRun {
  start: number;
  end: number;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
}

export interface MarkdownParagraph {
  text: string;
  style?: string;
  list?: "bullet" | "numbered";
  level?: number;
  runs?: InlineRun[];
  /** A fenced code block line: the whole paragraph is monospace. */
  code?: boolean;
}

type Flags = { bold: boolean; italic: boolean; code: boolean; link?: string };

function sameFlags(a: Flags, b: Flags) {
  return a.bold === b.bold && a.italic === b.italic && a.code === b.code && a.link === b.link;
}

/**
 * Parses inline markdown — **bold**, __bold__, *italic*, _italic_, `code`,
 * [label](url) and backslash escapes — into plain text plus styled runs. A
 * delimiter with no closing partner is kept as a literal character.
 */
export function parseInline(source: string): { text: string; runs: InlineRun[] } {
  const pieces: Array<{ text: string; flags: Flags }> = [];
  const push = (text: string, flags: Flags) => {
    if (!text) return;
    const last = pieces[pieces.length - 1];
    if (last && sameFlags(last.flags, flags)) last.text += text;
    else pieces.push({ text, flags: { ...flags } });
  };

  const walk = (src: string, base: Flags) => {
    const flags: Flags = { ...base };
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === "\\" && i + 1 < src.length && /[\\`*_[\]()#+\-.!|>~]/.test(src[i + 1])) {
        push(src[i + 1], flags);
        i += 2;
        continue;
      }
      if (ch === "`") {
        const close = src.indexOf("`", i + 1);
        if (close > i) {
          push(src.slice(i + 1, close), { ...flags, code: true });
          i = close + 1;
          continue;
        }
      }
      if (ch === "[") {
        const m = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(src.slice(i));
        if (m) {
          walk(m[1], { ...flags, link: m[2] });
          i += m[0].length;
          continue;
        }
      }
      if ((ch === "*" || ch === "_") && src[i + 1] === ch) {
        const delim = ch + ch;
        if (flags.bold || src.indexOf(delim, i + 2) > i + 1) {
          flags.bold = !flags.bold;
          i += 2;
          continue;
        }
      }
      if (ch === "*" || ch === "_") {
        const intraword = ch === "_" && /\w/.test(src[i - 1] ?? "") && /\w/.test(src[i + 1] ?? "");
        const rest = src.slice(i + 1);
        const hasClose = new RegExp(ch === "*" ? "(^|[^*])\\*(?!\\*)" : "(^|[^_])_(?!_)").test(rest);
        if (!intraword && (flags.italic || hasClose)) {
          flags.italic = !flags.italic;
          i += 1;
          continue;
        }
      }
      push(ch, flags);
      i += 1;
    }
  };
  walk(source, { bold: false, italic: false, code: false });

  let text = "";
  const runs: InlineRun[] = [];
  for (const piece of pieces) {
    const start = text.length;
    text += piece.text;
    const { bold, italic, code, link } = piece.flags;
    if (bold || italic || code || link) {
      const run: InlineRun = { start, end: text.length };
      if (bold) run.bold = true;
      if (italic) run.italic = true;
      if (code) run.code = true;
      if (link) run.link = link;
      runs.push(run);
    }
  }
  return { text, runs };
}

function withInline(source: string, extra: Omit<MarkdownParagraph, "text" | "runs">): MarkdownParagraph {
  const { text, runs } = parseInline(source);
  const paragraph: MarkdownParagraph = { text, ...extra };
  if (runs.length) paragraph.runs = runs;
  return paragraph;
}

function indentWidth(raw: string): number {
  let width = 0;
  for (const ch of raw) width += ch === "\t" ? 4 : 1;
  return width;
}

/**
 * Parses block markdown into paragraphs docs_write_tab can lay out: ATX
 * headings (# to ######), bullet (-, *, +) and numbered (1. or 1)) lists with
 * nesting by indentation, fenced code blocks (one monospace paragraph per
 * line), block quotes (italic), and plain paragraphs, whose soft-wrapped lines
 * are joined with a space. Horizontal rules are dropped; table rows are kept as
 * plain text lines.
 */
export function parseMarkdown(markdown: string): MarkdownParagraph[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: MarkdownParagraph[] = [];
  let pending: string[] = [];
  let listIndents: number[] = [];
  let fence: string | null = null;

  const flush = () => {
    if (pending.length) out.push(withInline(pending.join(" "), {}));
    pending = [];
  };

  for (const line of lines) {
    if (fence !== null) {
      if (line.trim().startsWith(fence)) {
        fence = null;
        continue;
      }
      out.push({ text: line.replace(/\t/g, "    "), code: true });
      continue;
    }
    const fenceOpen = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceOpen) {
      flush();
      listIndents = [];
      fence = fenceOpen[1];
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      listIndents = [];
      out.push(withInline(heading[2], { style: `HEADING_${heading[1].length}` }));
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      listIndents = [];
      continue;
    }
    const item = /^([ \t]*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const indent = indentWidth(item[1]);
      while (listIndents.length && indent < listIndents[listIndents.length - 1]) listIndents.pop();
      if (!listIndents.length || indent > listIndents[listIndents.length - 1]) listIndents.push(indent);
      const level = Math.min(listIndents.length - 1, 8);
      const list = /\d/.test(item[2]) ? "numbered" : "bullet";
      let body = item[3];
      const task = /^\[([ xX])\]\s+(.*)$/.exec(body);
      if (task) body = `${task[1] === " " ? "☐" : "☑"} ${task[2]}`;
      out.push(withInline(body, { list, level }));
      continue;
    }
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      listIndents = [];
      const p = withInline(quote[1], {});
      p.runs = [{ start: 0, end: p.text.length, italic: true }, ...(p.runs ?? [])];
      if (p.text.length) out.push(p);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
      const cells = line.trim().slice(1, -1).split("|").map((c) => c.trim());
      out.push(withInline(cells.join(" | "), {}));
      continue;
    }
    // A continuation line directly under a list item belongs to that item.
    const last = out[out.length - 1];
    if (!pending.length && last?.list && /^\s+\S/.test(line)) {
      const extra = parseInline(line.trim());
      const offset = last.text.length + 1;
      last.text += ` ${extra.text}`;
      if (extra.runs.length) {
        last.runs = [...(last.runs ?? []), ...extra.runs.map((r) => ({ ...r, start: r.start + offset, end: r.end + offset }))];
      }
      continue;
    }
    listIndents = [];
    pending.push(line.trim());
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Docs -> markdown

const MONOSPACE = /courier|consolas|mono|menlo|source code|inconsolata/i;

function isOrdered(lists: Record<string, docs_v1.Schema$List> | undefined | null, listId: string, level: number) {
  const nesting = lists?.[listId]?.listProperties?.nestingLevels?.[level];
  const glyph = nesting?.glyphType;
  return !!glyph && glyph !== "GLYPH_TYPE_UNSPECIFIED" && glyph !== "NONE";
}

function wrapRun(text: string, style: docs_v1.Schema$TextStyle | undefined | null): string {
  if (!text) return "";
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  let core = match[2];
  if (!core) return text;
  const font = style?.weightedFontFamily?.fontFamily ?? "";
  if (MONOSPACE.test(font)) core = `\`${core}\``;
  else {
    if (style?.bold && style?.italic) core = `***${core}***`;
    else if (style?.bold) core = `**${core}**`;
    else if (style?.italic) core = `*${core}*`;
  }
  const url = style?.link?.url;
  if (url) core = `[${core}](${url})`;
  else if (style?.link?.headingId) core = `[${core}](#heading=${style.link.headingId})`;
  return match[1] + core + match[3];
}

function paragraphInline(paragraph: docs_v1.Schema$Paragraph): string {
  let out = "";
  for (const el of paragraph.elements ?? []) {
    if (el.textRun) out += wrapRun((el.textRun.content ?? "").replace(/\n$/, ""), el.textRun.textStyle);
    else if (el.inlineObjectElement) out += "[image]";
    else if (el.horizontalRule) out += "---";
    else if (el.person) out += el.person.personProperties?.email ?? el.person.personProperties?.name ?? "";
    else if (el.richLink) out += `[${el.richLink.richLinkProperties?.title ?? "link"}](${el.richLink.richLinkProperties?.uri ?? ""})`;
  }
  return out.replace(/\u000b/g, " ").replace(/\s+$/, "");
}

const HEADING_PREFIX: Record<string, string> = {
  TITLE: "# ",
  SUBTITLE: "## ",
  HEADING_1: "# ",
  HEADING_2: "## ",
  HEADING_3: "### ",
  HEADING_4: "#### ",
  HEADING_5: "##### ",
  HEADING_6: "###### ",
};

function cellText(cell: docs_v1.Schema$TableCell): string {
  return (cell.content ?? [])
    .map((el) => (el.paragraph ? paragraphInline(el.paragraph) : ""))
    .filter(Boolean)
    .join(" ")
    .replace(/\|/g, "\\|");
}

/**
 * Renders one body (a tab's documentTab.body, or the legacy document body) as
 * compact markdown: headings, nested bullet and numbered lists (ordered-ness
 * read from the list's glyph type), bold, italic, monospace-as-code, links and
 * tables. Images become `[image]`. Everything else about styling is dropped.
 */
export function bodyToMarkdown(
  body: docs_v1.Schema$Body | undefined | null,
  lists?: Record<string, docs_v1.Schema$List> | null
): string {
  const blocks: Array<{ text: string; list: boolean }> = [];
  for (const element of body?.content ?? []) {
    if (element.table) {
      const rows = (element.table.tableRows ?? []).map((row) => (row.tableCells ?? []).map(cellText));
      if (!rows.length) continue;
      const width = Math.max(...rows.map((r) => r.length));
      const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
      const table = [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
      blocks.push({ text: table, list: false });
      continue;
    }
    const paragraph = element.paragraph;
    if (!paragraph) continue;
    const inline = paragraphInline(paragraph);
    const bullet = paragraph.bullet;
    if (bullet) {
      const level = bullet.nestingLevel ?? 0;
      const marker = isOrdered(lists, bullet.listId ?? "", level) ? "1." : "-";
      blocks.push({ text: `${"  ".repeat(level)}${marker} ${inline}`, list: true });
      continue;
    }
    if (!inline.trim()) continue;
    const prefix = HEADING_PREFIX[paragraph.paragraphStyle?.namedStyleType ?? ""] ?? "";
    blocks.push({ text: prefix + inline, list: false });
  }
  let out = "";
  blocks.forEach((block, i) => {
    if (i > 0) out += block.list && blocks[i - 1].list ? "\n" : "\n\n";
    out += block.text;
  });
  return out ? `${out}\n` : "";
}

export interface HeadingRef {
  tabId: string;
  tabTitle: string;
  headingId: string;
  style: string;
  text: string;
  url: string;
}

export function headingUrl(documentId: string, tabId: string | undefined, headingId: string): string {
  const tab = tabId ? `?tab=${encodeURIComponent(tabId)}` : "";
  return `https://docs.google.com/document/d/${documentId}/edit${tab}#heading=${headingId}`;
}

/** Every heading paragraph (one that carries a headingId) in a body. */
export function headingsIn(
  documentId: string,
  body: docs_v1.Schema$Body | undefined | null,
  tabId: string,
  tabTitle: string
): HeadingRef[] {
  const out: HeadingRef[] = [];
  for (const element of body?.content ?? []) {
    const style = element.paragraph?.paragraphStyle;
    if (!style?.headingId) continue;
    const text = (element.paragraph?.elements ?? [])
      .map((run) => run.textRun?.content ?? "")
      .join("")
      .trim();
    out.push({
      tabId,
      tabTitle,
      headingId: style.headingId,
      style: style.namedStyleType ?? "",
      text,
      url: headingUrl(documentId, tabId || undefined, style.headingId),
    });
  }
  return out;
}
