import type { slides_v1 } from "@googleapis/slides";
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
  ];
}

export const slidesTools = createSlidesTools();
