import type { slides_v1 } from "@googleapis/slides";
import fs from "fs";
import path from "path";
import { getAuthenticatedClient } from "../auth.js";
import { getAccountNames } from "../config.js";

type SlidesClient = slides_v1.Slides;

async function getSlides(account: string): Promise<SlidesClient> {
  const { slides } = await import("@googleapis/slides");
  return slides({ version: "v1", auth: getAuthenticatedClient(account) as never });
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

export interface SlideOutlineEntry {
  objectId: string;
  index: number;
  elements: Array<{ objectId: string; text: string }>;
}

/**
 * One entry per slide, carrying the object IDs a batchUpdate needs and the text
 * already in each shape. The raw `presentations.get` response describes every
 * element's geometry and styling and is far too large to read directly.
 */
export function summarizePresentation(
  presentation: slides_v1.Schema$Presentation
): SlideOutlineEntry[] {
  return (presentation.slides ?? []).map((slide, index) => ({
    objectId: slide.objectId ?? "",
    index,
    elements: (slide.pageElements ?? [])
      .map((element) => ({
        objectId: element.objectId ?? "",
        text: (element.shape?.text?.textElements ?? [])
          .map((run) => run.textRun?.content ?? "")
          .join("")
          .replace(/\n+$/, ""),
      }))
      .filter((element) => element.text !== ""),
  }));
}

/**
 * Turns a plain outline into the request list that builds a deck: one
 * TITLE_AND_BODY slide per entry, with the title and the bullets inserted into
 * the placeholders that slide is created with.
 *
 * Slides has no HTML import — this and a converted .pptx upload are the only
 * two ways to produce a deck — so this covers the common ask without making the
 * caller hand-write placeholder plumbing.
 */
export function outlineToRequests(
  outline: Array<{ title: string; bullets?: string[] }>
): Record<string, unknown>[] {
  const requests: Record<string, unknown>[] = [];
  outline.forEach((slide, index) => {
    const slideId = `slide_${index}`;
    const titleId = `${slideId}_title`;
    const bodyId = `${slideId}_body`;
    requests.push({
      createSlide: {
        objectId: slideId,
        slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
        placeholderIdMappings: [
          { layoutPlaceholder: { type: "TITLE" }, objectId: titleId },
          { layoutPlaceholder: { type: "BODY" }, objectId: bodyId },
        ],
      },
    });
    requests.push({ insertText: { objectId: titleId, text: slide.title } });
    if (slide.bullets && slide.bullets.length > 0) {
      requests.push({ insertText: { objectId: bodyId, text: slide.bullets.join("\n") } });
      requests.push({
        createParagraphBullets: {
          objectId: bodyId,
          textRange: { type: "ALL" },
          bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
        },
      });
    }
  });
  return requests;
}

export function createSlidesTools(
  getClient: (account: string) => SlidesClient | Promise<SlidesClient> = getSlides,
  getAccounts: () => string[] = getAccountNames
) {
  const account = { type: "string" as const, description: "Account label" };
  const presentationId = { type: "string" as const, description: "Google Slides file ID" };

  return [
    {
      name: "slides_get_structure",

      readOnly: true,
      description:
        "Read a Google Slides deck as one entry per slide: the slide's object ID and the object " +
        "ID and current text of each shape on it. Those object IDs are what slides_batch_update " +
        `edits against. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: { account, presentation_id: presentationId },
        required: ["account", "presentation_id"],
      },
      handler: async (args: { account: string; presentation_id: string }) => {
        const slides = await getClient(args.account);
        const res = await slides.presentations.get({
          presentationId: args.presentation_id,
        } as never);
        return asText({
          presentationId: res.data.presentationId,
          title: res.data.title,
          slides: summarizePresentation(res.data),
        });
      },
    },
    {
      name: "slides_replace_text",

      readOnly: false,
      description:
        "Find and replace text across every slide in a deck, leaving layout and styling alone. " +
        `${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          presentation_id: presentationId,
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
        required: ["account", "presentation_id", "replacements"],
      },
      handler: async (args: {
        account: string;
        presentation_id: string;
        replacements: Array<{ find: string; replace: string; match_case?: boolean }>;
      }) => {
        if (!args.replacements || args.replacements.length === 0) {
          throw new Error("replacements must contain at least one find/replace pair");
        }
        const slides = await getClient(args.account);
        const res = await slides.presentations.batchUpdate({
          presentationId: args.presentation_id,
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
      name: "slides_add_from_outline",

      readOnly: false,
      description:
        "Append slides to a deck from a plain outline — a title and optional bullets per slide. " +
        "Slides has no HTML import, so this is the direct route to building a deck; the other " +
        "is uploading a .pptx through drive_upload and letting Drive convert it. " +
        `${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          presentation_id: presentationId,
          outline: {
            type: "array" as const,
            description: "One entry per slide, in order.",
            items: {
              type: "object" as const,
              properties: {
                title: { type: "string" as const, description: "Slide title" },
                bullets: {
                  type: "array" as const,
                  description: "Body bullets",
                  items: { type: "string" as const },
                },
              },
              required: ["title"],
            },
          },
        },
        required: ["account", "presentation_id", "outline"],
      },
      handler: async (args: {
        account: string;
        presentation_id: string;
        outline: Array<{ title: string; bullets?: string[] }>;
      }) => {
        if (!args.outline || args.outline.length === 0) {
          throw new Error("outline must contain at least one slide");
        }
        const slides = await getClient(args.account);
        const res = await slides.presentations.batchUpdate({
          presentationId: args.presentation_id,
          requestBody: { requests: outlineToRequests(args.outline) },
        } as never);
        return asText(res.data);
      },
    },
    {
      name: "slides_batch_update",

      readOnly: false,
      description:
        "Apply raw Slides API requests: createSlide, insertText, deleteText, createImage, " +
        "updateShapeProperties, updateTextStyle, tables and the rest. The whole batch is applied " +
        `atomically. Read slides_get_structure first for the object IDs. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          presentation_id: presentationId,
          requests: {
            type: "array" as const,
            description: "Slides API Request objects.",
            items: { type: "object" as const },
          },
        },
        required: ["account", "presentation_id", "requests"],
      },
      handler: async (args: {
        account: string;
        presentation_id: string;
        requests: Record<string, unknown>[];
      }) => {
        if (!args.requests || args.requests.length === 0) {
          throw new Error("requests must contain at least one Slides API request");
        }
        const slides = await getClient(args.account);
        const res = await slides.presentations.batchUpdate({
          presentationId: args.presentation_id,
          requestBody: { requests: args.requests },
        } as never);
        return asText(res.data);
      },
    },
    {
      name: "slides_read_text",

      readOnly: true,
      description:
        "Read all the text of a deck, slide by slide: text in shapes, table cells and the speaker " +
        "notes of each slide, with the object ID of every element. slides_get_structure returns " +
        "shape text only; this adds tables and speaker notes. " +
        `${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: { account, presentation_id: presentationId },
        required: ["account", "presentation_id"],
      },
      handler: async (args: { account: string; presentation_id: string }) => {
        const slides = await getClient(args.account);
        const res = await slides.presentations.get({ presentationId: args.presentation_id } as never);
        return asText({
          presentationId: res.data.presentationId,
          title: res.data.title,
          slides: readPresentationText(res.data),
        });
      },
    },
    {
      name: "slides_get_thumbnail",

      readOnly: true,
      description:
        "Get a short-lived image URL for a slide's thumbnail (PNG). Use slides_get_structure for " +
        "slide object IDs. The URL expires after about 30 minutes and is only meant to be " +
        "fetched, not stored; slides_save_thumbnail saves the PNG to disk. " +
        `${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          presentation_id: presentationId,
          slide_id: { type: "string" as const, description: "Slide object ID" },
          size: { type: "string" as const, description: "SMALL (200px), MEDIUM (800px) or LARGE (1600px, default)" },
        },
        required: ["account", "presentation_id", "slide_id"],
      },
      handler: async (args: { account: string; presentation_id: string; slide_id: string; size?: string }) => {
        const slides = await getClient(args.account);
        const res = await slides.presentations.pages.getThumbnail(thumbnailRequest(args) as never);
        return asText({ slideId: args.slide_id, ...res.data });
      },
    },
    {
      name: "slides_save_thumbnail",

      readOnly: false,
      description:
        "Render a slide's thumbnail and save the PNG to a local path. Writes a local file, so it " +
        `is a write tool; use slides_get_thumbnail for just the URL. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          presentation_id: presentationId,
          slide_id: { type: "string" as const, description: "Slide object ID" },
          destination_path: { type: "string" as const, description: "Where to write the PNG" },
          size: { type: "string" as const, description: "SMALL, MEDIUM or LARGE (default)" },
        },
        required: ["account", "presentation_id", "slide_id", "destination_path"],
      },
      handler: async (args: {
        account: string;
        presentation_id: string;
        slide_id: string;
        destination_path: string;
        size?: string;
      }) => {
        const slides = await getClient(args.account);
        const res = await slides.presentations.pages.getThumbnail(thumbnailRequest(args) as never);
        const url = res.data.contentUrl;
        if (!url) throw new Error("Slides returned no thumbnail URL");
        const image = await fetch(url);
        if (!image.ok) throw new Error(`thumbnail download failed: HTTP ${image.status}`);
        const bytes = Buffer.from(await image.arrayBuffer());
        fs.mkdirSync(path.dirname(args.destination_path), { recursive: true });
        fs.writeFileSync(args.destination_path, bytes);
        return asText({ slideId: args.slide_id, path: args.destination_path, byteCount: bytes.length });
      },
    },
    {
      name: "slides_delete_slide",

      readOnly: false,
      description:
        "DESTRUCTIVE: delete a slide (or any page element) by object ID, with everything on it. " +
        "Recoverable only from Drive version history. Get object IDs from slides_get_structure. " +
        `${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          presentation_id: presentationId,
          slide_id: { type: "string" as const, description: "Slide object ID" },
        },
        required: ["account", "presentation_id", "slide_id"],
      },
      handler: async (args: { account: string; presentation_id: string; slide_id: string }) => {
        const slides = await getClient(args.account);
        const res = await slides.presentations.batchUpdate({
          presentationId: args.presentation_id,
          requestBody: { requests: [{ deleteObject: { objectId: args.slide_id } }] },
        } as never);
        return asText({ presentationId: args.presentation_id, slideId: args.slide_id, deleted: true, replies: res.data.replies });
      },
    },
    {
      name: "slides_duplicate_slide",

      readOnly: false,
      description:
        "Duplicate a slide; the copy is inserted right after the original. Returns the new " +
        "slide's object ID. Use slides_reorder_slides to move it. " +
        `${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          presentation_id: presentationId,
          slide_id: { type: "string" as const, description: "Slide object ID to copy" },
        },
        required: ["account", "presentation_id", "slide_id"],
      },
      handler: async (args: { account: string; presentation_id: string; slide_id: string }) => {
        const slides = await getClient(args.account);
        const res = await slides.presentations.batchUpdate({
          presentationId: args.presentation_id,
          requestBody: { requests: [{ duplicateObject: { objectId: args.slide_id } }] },
        } as never);
        const newId = (res.data.replies ?? [])[0]?.duplicateObject?.objectId;
        return asText({ presentationId: args.presentation_id, sourceSlideId: args.slide_id, newSlideId: newId });
      },
    },
    {
      name: "slides_reorder_slides",

      readOnly: false,
      description:
        "Move slides to a new position. slide_ids are moved together, keeping their current " +
        "relative order, so that the first lands at insertion_index (0-based, counted in the deck " +
        `before the move). ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          presentation_id: presentationId,
          slide_ids: { type: "array" as const, description: "Slide object IDs to move", items: { type: "string" as const } },
          insertion_index: { type: "number" as const, description: "Target position, 0 = first" },
        },
        required: ["account", "presentation_id", "slide_ids", "insertion_index"],
      },
      handler: async (args: { account: string; presentation_id: string; slide_ids: string[]; insertion_index: number }) => {
        if (!args.slide_ids || args.slide_ids.length === 0) throw new Error("slide_ids must contain at least one slide");
        if (!Number.isInteger(args.insertion_index) || args.insertion_index < 0) {
          throw new Error("insertion_index must be a non-negative integer");
        }
        const slides = await getClient(args.account);
        const res = await slides.presentations.batchUpdate({
          presentationId: args.presentation_id,
          requestBody: {
            requests: [{ updateSlidesPosition: { slideObjectIds: args.slide_ids, insertionIndex: args.insertion_index } }],
          },
        } as never);
        return asText(res.data);
      },
    },
    {
      name: "slides_insert_image",

      readOnly: false,
      description:
        "Insert an image from a public URL onto a slide (PNG, JPEG or GIF under 50MB; Google " +
        "fetches the URL). Optional position and size in points (1pt = 12700 EMU); omit them to " +
        `let Slides place it at its natural size. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          presentation_id: presentationId,
          slide_id: { type: "string" as const, description: "Slide object ID" },
          url: { type: "string" as const, description: "Publicly reachable image URL" },
          x: { type: "number" as const, description: "Left offset in points" },
          y: { type: "number" as const, description: "Top offset in points" },
          width: { type: "number" as const, description: "Width in points" },
          height: { type: "number" as const, description: "Height in points" },
        },
        required: ["account", "presentation_id", "slide_id", "url"],
      },
      handler: async (args: {
        account: string;
        presentation_id: string;
        slide_id: string;
        url: string;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
      }) => {
        if (!/^https?:\/\//i.test(args.url)) throw new Error("url must be an http(s) URL");
        if ((args.width === undefined) !== (args.height === undefined)) {
          throw new Error("pass both width and height, or neither");
        }
        const elementProperties: Record<string, unknown> = { pageObjectId: args.slide_id };
        if (args.width !== undefined && args.height !== undefined) {
          elementProperties.size = {
            width: { magnitude: args.width, unit: "PT" },
            height: { magnitude: args.height, unit: "PT" },
          };
        }
        if (args.x !== undefined || args.y !== undefined) {
          elementProperties.transform = {
            scaleX: 1,
            scaleY: 1,
            translateX: args.x ?? 0,
            translateY: args.y ?? 0,
            unit: "PT",
          };
        }
        const slides = await getClient(args.account);
        const res = await slides.presentations.batchUpdate({
          presentationId: args.presentation_id,
          requestBody: { requests: [{ createImage: { url: args.url, elementProperties } }] },
        } as never);
        return asText({
          presentationId: args.presentation_id,
          imageObjectId: (res.data.replies ?? [])[0]?.createImage?.objectId,
        });
      },
    },
    {
      name: "slides_set_speaker_notes",

      readOnly: false,
      description:
        "Replace a slide's speaker notes with the given text (empty string clears them). " +
        "Overwrites any existing notes. Read them first with slides_read_text. " +
        `${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          presentation_id: presentationId,
          slide_id: { type: "string" as const, description: "Slide object ID" },
          notes: { type: "string" as const, description: "New speaker notes text" },
        },
        required: ["account", "presentation_id", "slide_id", "notes"],
      },
      handler: async (args: { account: string; presentation_id: string; slide_id: string; notes: string }) => {
        const slides = await getClient(args.account);
        const deck = await slides.presentations.get({ presentationId: args.presentation_id } as never);
        const slide = (deck.data.slides ?? []).find((s) => s.objectId === args.slide_id);
        if (!slide) throw new Error(`no slide with object ID ${args.slide_id}`);
        const notesPage = slide.slideProperties?.notesPage;
        const notesId = notesPage?.notesProperties?.speakerNotesObjectId;
        if (!notesId) throw new Error("this slide has no speaker notes shape");
        const shape = (notesPage?.pageElements ?? []).find((e) => e.objectId === notesId);
        const existing = shapeText(shape?.shape?.text);
        const requests: Record<string, unknown>[] = [];
        if (existing !== "") requests.push({ deleteText: { objectId: notesId, textRange: { type: "ALL" } } });
        if (args.notes !== "") requests.push({ insertText: { objectId: notesId, insertionIndex: 0, text: args.notes } });
        if (requests.length === 0) return asText({ slideId: args.slide_id, notesObjectId: notesId, changed: false });
        await slides.presentations.batchUpdate({
          presentationId: args.presentation_id,
          requestBody: { requests },
        } as never);
        return asText({ slideId: args.slide_id, notesObjectId: notesId, changed: true });
      },
    },
  ];
}

function shapeText(text: slides_v1.Schema$TextContent | undefined): string {
  return (text?.textElements ?? []).map((run) => run.textRun?.content ?? "").join("").replace(/\n+$/, "");
}

function thumbnailRequest(args: { presentation_id: string; slide_id: string; size?: string }) {
  const size = (args.size ?? "LARGE").toUpperCase();
  if (!["SMALL", "MEDIUM", "LARGE"].includes(size)) throw new Error("size must be SMALL, MEDIUM or LARGE");
  return {
    presentationId: args.presentation_id,
    pageObjectId: args.slide_id,
    "thumbnailProperties.mimeType": "PNG",
    "thumbnailProperties.thumbnailSize": size,
  };
}

/** Per slide: shape text, table cell text and speaker notes, each tagged with its object ID. */
export function readPresentationText(presentation: slides_v1.Schema$Presentation) {
  return (presentation.slides ?? []).map((slide, index) => {
    const elements: Array<{ objectId: string; kind: string; text: string }> = [];
    for (const element of slide.pageElements ?? []) {
      const objectId = element.objectId ?? "";
      const text = shapeText(element.shape?.text);
      if (text) elements.push({ objectId, kind: "shape", text });
      for (const row of element.table?.tableRows ?? []) {
        const cells = (row.tableCells ?? []).map((cell) => shapeText(cell.text));
        if (cells.some((c) => c !== "")) elements.push({ objectId, kind: "table-row", text: cells.join(" | ") });
      }
    }
    const notesPage = slide.slideProperties?.notesPage;
    const notesId = notesPage?.notesProperties?.speakerNotesObjectId;
    const notesShape = (notesPage?.pageElements ?? []).find((e) => e.objectId === notesId);
    return {
      objectId: slide.objectId ?? "",
      index,
      elements,
      speakerNotes: shapeText(notesShape?.shape?.text),
    };
  });
}

export const slidesTools = createSlidesTools();
