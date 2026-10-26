import type { drive_v3 } from "@googleapis/drive";
import type { forms_v1 } from "@googleapis/forms";
import { getAuthenticatedClient } from "../auth.js";
import { getAccountNames } from "../config.js";
import { SCOPE, grantedScopes, withScope, type ScopeLookup } from "../scopes.js";

type FormsClient = forms_v1.Forms;
type DriveLike = Pick<drive_v3.Drive, "files">;

async function getForms(account: string): Promise<FormsClient> {
  const { forms } = await import("@googleapis/forms");
  return forms({ version: "v1", auth: getAuthenticatedClient(account) as never });
}

async function getDriveFor(account: string): Promise<DriveLike> {
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

function asText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export interface FormQuestion {
  title?: string;
  /** One of QUESTION_TYPES. */
  type: string;
  description?: string;
  required?: boolean;
  /** Choice types: the option values. */
  options?: string[];
  /** Choice types: add an "Other" option (its value is set by the responder). */
  other?: boolean;
  /** Choice types: shuffle the option order for each responder. */
  shuffle?: boolean;
  /** scale: 0 or 1. */
  low?: number;
  /** scale: 2 to 10. */
  high?: number;
  low_label?: string;
  high_label?: string;
  /** date: include the year (default true). */
  include_year?: boolean;
  /** date: also ask for a time (default false). */
  include_time?: boolean;
  /** time: ask for an elapsed duration rather than a time of day. */
  duration?: boolean;
  /** rating: number of rating levels (default 5). */
  rating_levels?: number;
  /** rating: STAR, HEART or THUMB_UP (default STAR). */
  icon?: string;
  /** grid: row labels (one row question each). */
  rows?: string[];
  /** grid: column labels. */
  columns?: string[];
  /** grid: RADIO (one per row, default) or CHECKBOX. */
  column_type?: string;
  /** grid: shuffle the row order. */
  shuffle_rows?: boolean;
  /** image: publicly fetchable image URL (the API copies it). */
  source_uri?: string;
  alt_text?: string;
  /** video: YouTube URL. */
  youtube_uri?: string;
  caption?: string;
}

const CHOICE_TYPES: Record<string, string> = {
  multiple_choice: "RADIO",
  checkboxes: "CHECKBOX",
  dropdown: "DROP_DOWN",
};
const GRID_COLUMN_TYPES = ["RADIO", "CHECKBOX"];
const ICON_TYPES = ["STAR", "HEART", "THUMB_UP"];
const EMAIL_COLLECTION_TYPES = ["DO_NOT_COLLECT", "VERIFIED", "RESPONDER_INPUT"];
/** Item kinds that need no title. */
const UNTITLED_TYPES = new Set(["page_break", "image", "video"]);

export const QUESTION_TYPES = [
  "short_text",
  "paragraph",
  ...Object.keys(CHOICE_TYPES),
  "scale",
  "date",
  "time",
  "rating",
  "grid",
  "text",
  "page_break",
  "image",
  "video",
];

const trimmed = (values: string[] | undefined) => (values ?? []).map((v) => v.trim()).filter(Boolean);

function questionKind(q: FormQuestion, index: number): Record<string, unknown> {
  const at = `question ${index}`;
  const question: Record<string, unknown> = { required: !!q.required };
  if (q.type === "short_text" || q.type === "paragraph") {
    question.textQuestion = { paragraph: q.type === "paragraph" };
  } else if (q.type in CHOICE_TYPES) {
    const values = trimmed(q.options);
    if (!values.length) throw new Error(`${at} (${q.type}) needs options`);
    const options: Record<string, unknown>[] = values.map((value) => ({ value }));
    if (q.other) options.push({ isOther: true });
    question.choiceQuestion = {
      type: CHOICE_TYPES[q.type],
      options,
      ...(q.shuffle ? { shuffle: true } : {}),
    };
  } else if (q.type === "scale") {
    const low = q.low ?? 1;
    const high = q.high ?? 5;
    if (!(low === 0 || low === 1) || high < 2 || high > 10) {
      throw new Error(`${at} scale needs low 0 or 1 and high 2-10`);
    }
    question.scaleQuestion = {
      low,
      high,
      ...(q.low_label ? { lowLabel: q.low_label } : {}),
      ...(q.high_label ? { highLabel: q.high_label } : {}),
    };
  } else if (q.type === "date") {
    question.dateQuestion = { includeYear: q.include_year !== false, includeTime: !!q.include_time };
  } else if (q.type === "time") {
    question.timeQuestion = { duration: !!q.duration };
  } else if (q.type === "rating") {
    const level = q.rating_levels ?? 5;
    const icon = (q.icon ?? "STAR").toUpperCase();
    if (!Number.isInteger(level) || level < 1) throw new Error(`${at} rating needs rating_levels as a positive integer`);
    if (!ICON_TYPES.includes(icon)) throw new Error(`${at} rating icon must be one of ${ICON_TYPES.join(", ")}`);
    question.ratingQuestion = { ratingScaleLevel: level, iconType: icon };
  } else {
    throw new Error(`${at} has unknown type ${q.type}; use one of ${QUESTION_TYPES.join(", ")}`);
  }
  return question;
}

function itemKind(q: FormQuestion, index: number): Record<string, unknown> {
  const at = `question ${index}`;
  switch (q.type) {
    case "text":
      return { textItem: {} };
    case "page_break":
      return { pageBreakItem: {} };
    case "image": {
      if (!q.source_uri) throw new Error(`${at} (image) needs source_uri`);
      return { imageItem: { image: { sourceUri: q.source_uri, ...(q.alt_text ? { altText: q.alt_text } : {}) } } };
    }
    case "video": {
      if (!q.youtube_uri) throw new Error(`${at} (video) needs youtube_uri`);
      return { videoItem: { video: { youtubeUri: q.youtube_uri }, ...(q.caption ? { caption: q.caption } : {}) } };
    }
    case "grid": {
      const rows = trimmed(q.rows);
      const columns = trimmed(q.columns);
      if (!rows.length || !columns.length) throw new Error(`${at} (grid) needs rows and columns`);
      const columnType = (q.column_type ?? "RADIO").toUpperCase();
      if (!GRID_COLUMN_TYPES.includes(columnType)) throw new Error(`${at} grid column_type must be RADIO or CHECKBOX`);
      return {
        questionGroupItem: {
          questions: rows.map((row) => ({ required: !!q.required, rowQuestion: { title: row } })),
          grid: {
            columns: { type: columnType, options: columns.map((value) => ({ value })) },
            ...(q.shuffle_rows ? { shuffleQuestions: true } : {}),
          },
        },
      };
    }
    case "file_upload":
      throw new Error(`${at}: file upload questions cannot be created through the Forms API; add them in the Forms UI`);
    default:
      return { questionItem: { question: questionKind(q, index) } };
  }
}

/** One createItem request per item, placed in order. Covers every item kind the API can create. */
export function buildQuestionRequests(questions: FormQuestion[]): Record<string, unknown>[] {
  return questions.map((q, index) => {
    if (!UNTITLED_TYPES.has(q.type) && !q.title?.trim()) throw new Error(`question ${index} has no title`);
    const item: Record<string, unknown> = {};
    if (q.title?.trim()) item.title = q.title;
    if (q.description) item.description = q.description;
    Object.assign(item, itemKind(q, index));
    return { createItem: { item, location: { index } } };
  });
}

/** Maps each response's answers from questionId to question title. */
export function flattenResponses(form: forms_v1.Schema$Form, responses: forms_v1.Schema$FormResponse[]) {
  const titles: Record<string, string> = {};
  for (const item of form.items ?? []) {
    const id = item.questionItem?.question?.questionId;
    if (id) titles[id] = item.title ?? id;
    for (const q of item.questionGroupItem?.questions ?? []) {
      if (q.questionId) titles[q.questionId] = `${item.title ?? ""} — ${q.rowQuestion?.title ?? q.questionId}`;
    }
  }
  return responses.map((r) => {
    const answers: Record<string, string | string[]> = {};
    for (const [questionId, answer] of Object.entries(r.answers ?? {})) {
      const values = (answer.textAnswers?.answers ?? []).map((a) => a.value ?? "");
      const files = (answer.fileUploadAnswers?.answers ?? []).map((f) => f.fileName ?? f.fileId ?? "");
      const all = [...values, ...files];
      answers[titles[questionId] ?? questionId] = all.length === 1 ? all[0] : all;
    }
    return {
      responseId: r.responseId,
      submitted: r.lastSubmittedTime ?? r.createTime,
      respondentEmail: r.respondentEmail,
      answers,
    };
  });
}

const questionSchema = {
  type: "object" as const,
  properties: {
    title: { type: "string" as const, description: "Question or item text (not needed for page_break, image, video)" },
    type: { type: "string" as const, description: QUESTION_TYPES.join(", ") },
    description: { type: "string" as const, description: "Help text" },
    required: { type: "boolean" as const, description: "Required answer" },
    options: { type: "array" as const, description: "Choices (multiple_choice, checkboxes, dropdown)", items: { type: "string" as const } },
    other: { type: "boolean" as const, description: "Choice types: add an Other option" },
    shuffle: { type: "boolean" as const, description: "Choice types: shuffle option order" },
    low: { type: "number" as const, description: "Scale low (0 or 1)" },
    high: { type: "number" as const, description: "Scale high (2-10)" },
    low_label: { type: "string" as const, description: "Scale low label" },
    high_label: { type: "string" as const, description: "Scale high label" },
    include_year: { type: "boolean" as const, description: "date: include year (default true)" },
    include_time: { type: "boolean" as const, description: "date: also ask for a time (default false)" },
    duration: { type: "boolean" as const, description: "time: elapsed duration instead of time of day" },
    rating_levels: { type: "number" as const, description: "rating: number of levels (default 5)" },
    icon: { type: "string" as const, description: "rating: STAR, HEART or THUMB_UP" },
    rows: { type: "array" as const, description: "grid: row labels", items: { type: "string" as const } },
    columns: { type: "array" as const, description: "grid: column labels", items: { type: "string" as const } },
    column_type: { type: "string" as const, description: "grid: RADIO (default) or CHECKBOX" },
    shuffle_rows: { type: "boolean" as const, description: "grid: shuffle row order" },
    source_uri: { type: "string" as const, description: "image: URL of the image" },
    alt_text: { type: "string" as const, description: "image: alt text" },
    youtube_uri: { type: "string" as const, description: "video: YouTube URL" },
    caption: { type: "string" as const, description: "video: caption" },
  },
  required: ["type"],
};

const ITEM_KIND_NOTE =
  "Item kinds: choice (multiple_choice radio, checkboxes, dropdown, with other and shuffle), short_text, paragraph, " +
  "scale, date (year/time options), time (time of day or duration), rating, grid (rows of questions sharing columns), " +
  "text (a text block), page_break (new page), image (from a URL), video (YouTube). File-upload questions cannot be " +
  "created through the API.";

/**
 * Google Forms tools. Forms created through the API after 2026-06-30 start
 * unpublished, so forms_create publishes explicitly unless publish=false.
 * The drive scope already satisfies these methods; forms.body and
 * forms.responses.readonly are also accepted.
 */
export function createFormsTools(
  getClient: (account: string) => FormsClient | Promise<FormsClient> = getForms,
  getAccounts: () => string[] = getAccountNames,
  scopes: ScopeLookup = grantedScopes,
  getDriveClient: (account: string) => DriveLike | Promise<DriveLike> = getDriveFor
) {
  const account = { type: "string" as const, description: "Account label" };
  const formId = { type: "string" as const, description: "Form ID (from the form's URL /forms/d/<id>/edit)" };
  const index = { type: "number" as const, description: "Item index (0 = first item)" };

  return [
    {
      name: "forms_create",

      readOnly: false,
      description:
        "Create a Google Form with questions in one call. Forms created through the API start unpublished, so " +
        "this publishes and accepts responses unless publish=false. " +
        ITEM_KIND_NOTE +
        " Returns formId, responderUri, the published state and the edit URL. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          title: { type: "string" as const, description: "Form title shown to respondents" },
          document_title: { type: "string" as const, description: "Drive file name (default: title)" },
          description: { type: "string" as const, description: "Form description" },
          publish: { type: "boolean" as const, description: "Publish and accept responses (default true)" },
          questions: { type: "array" as const, description: "Items in order", items: questionSchema },
        },
        required: ["account", "title"],
      },
      handler: async (args: {
        account: string;
        title: string;
        document_title?: string;
        description?: string;
        publish?: boolean;
        questions?: FormQuestion[];
      }) =>
        withScope(args.account, [SCOPE.drive, SCOPE.formsBody], scopes, async () => {
          const requests: Record<string, unknown>[] = [];
          if (args.description) {
            requests.push({ updateFormInfo: { info: { description: args.description }, updateMask: "description" } });
          }
          requests.push(...buildQuestionRequests(args.questions ?? []));
          const publish = args.publish !== false;
          const forms = await getClient(args.account);
          const created = await forms.forms.create({
            unpublished: !publish,
            requestBody: { info: { title: args.title, documentTitle: args.document_title ?? args.title } },
          } as never);
          const form = created.data as forms_v1.Schema$Form;
          const id = form.formId!;
          if (requests.length) {
            await forms.forms.batchUpdate({ formId: id, requestBody: { requests } } as never);
          }
          if (publish) {
            await forms.forms.setPublishSettings({
              formId: id,
              requestBody: {
                publishSettings: { publishState: { isPublished: true, isAcceptingResponses: true } },
                updateMask: "publishState",
              },
            } as never);
          }
          return asText({
            formId: id,
            title: args.title,
            published: publish,
            acceptingResponses: publish,
            note: publish
              ? "Published and accepting responses."
              : "Created unpublished. Call forms_set_publish_settings before sharing the responder link.",
            questions: (args.questions ?? []).length,
            responderUri: form.responderUri,
            editUrl: `https://docs.google.com/forms/d/${id}/edit`,
          });
        }),
    },
    {
      name: "forms_set_publish_settings",

      readOnly: false,
      description:
        "Publish or unpublish a Google Form, and set whether it accepts responses. A form must be published " +
        "before its responder link works for others; unpublished forms cannot accept responses. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          form_id: formId,
          published: { type: "boolean" as const, description: "Publish (true) or unpublish (false)" },
          accepting_responses: {
            type: "boolean" as const,
            description: "Accept responses (default: same as published). Must be false when unpublished.",
          },
        },
        required: ["account", "form_id", "published"],
      },
      handler: async (args: { account: string; form_id: string; published: boolean; accepting_responses?: boolean }) =>
        withScope(args.account, [SCOPE.drive, SCOPE.formsBody], scopes, async () => {
          if (typeof args.published !== "boolean") throw new Error("published must be true or false");
          const accepting = args.accepting_responses ?? args.published;
          if (!args.published && accepting) throw new Error("an unpublished form cannot accept responses");
          const forms = await getClient(args.account);
          const res = await forms.forms.setPublishSettings({
            formId: args.form_id,
            requestBody: {
              publishSettings: { publishState: { isPublished: args.published, isAcceptingResponses: accepting } },
              updateMask: "publishState",
            },
          } as never);
          return asText(res.data);
        }),
    },
    {
      name: "forms_responder_url",

      readOnly: true,
      description:
        "Return a Google Form's responder link and publish state as a short summary line, plus the edit URL. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: { account, form_id: formId },
        required: ["account", "form_id"],
      },
      handler: async (args: { account: string; form_id: string }) =>
        withScope(args.account, [SCOPE.drive, SCOPE.driveReadonly, SCOPE.formsBody, SCOPE.formsBodyReadonly], scopes, async () => {
          const forms = await getClient(args.account);
          const form = (await forms.forms.get({ formId: args.form_id } as never)).data as forms_v1.Schema$Form;
          const state = form.publishSettings?.publishState;
          const published = !!state?.isPublished;
          const accepting = !!state?.isAcceptingResponses;
          const title = form.info?.title ?? args.form_id;
          const responderUri = form.responderUri ?? null;
          const status = published ? (accepting ? "published, accepting responses" : "published, not accepting responses") : "unpublished";
          return asText({
            formId: args.form_id,
            title,
            published,
            acceptingResponses: accepting,
            responderUri,
            editUrl: `https://docs.google.com/forms/d/${args.form_id}/edit`,
            summary: `"${title}" is ${status}: ${responderUri ?? "no responder link yet"}`,
          });
        }),
    },
    {
      name: "forms_list",

      readOnly: true,
      description:
        "List the Google Forms in an account's Drive (newest first): id, name, modified time and link. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          max_results: { type: "number" as const, description: "Maximum forms (default 25, up to 1000)" },
        },
        required: ["account"],
      },
      handler: async (args: { account: string; max_results?: number }) =>
        withScope(args.account, [SCOPE.drive, SCOPE.driveReadonly], scopes, async () => {
          const drive = await getDriveClient(args.account);
          const res = await drive.files.list({
            q: "mimeType = 'application/vnd.google-apps.form' and trashed = false",
            fields: "files(id,name,modifiedTime,webViewLink)",
            orderBy: "modifiedTime desc",
            pageSize: Math.min(args.max_results ?? 25, 1000),
          } as never);
          const files = (res.data.files ?? []) as unknown[];
          return asText({ count: files.length, forms: files });
        }),
    },
    {
      name: "forms_get",

      readOnly: true,
      description:
        "Read a Google Form's full structure: info, settings, responderUri, linkedSheetId and every " +
        "item with its itemId and question ids and types (choice options, scale bounds, etc.), in " +
        "order. Use the itemIds and indexes with forms_batch_update to edit, move or delete items. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: { account, form_id: formId },
        required: ["account", "form_id"],
      },
      handler: async (args: { account: string; form_id: string }) =>
        withScope(args.account, [SCOPE.drive, SCOPE.driveReadonly, SCOPE.formsBody, SCOPE.formsBodyReadonly], scopes, async () => {
          const forms = await getClient(args.account);
          const res = await forms.forms.get({ formId: args.form_id } as never);
          return asText(res.data);
        }),
    },
    {
      name: "forms_add_questions",

      readOnly: false,
      description:
        "Append items to an existing Google Form (same shapes as forms_create). By default they go after the " +
        "current last item; position inserts them at that item index instead. Returns the form's new item count. " +
        ITEM_KIND_NOTE +
        " " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          form_id: formId,
          position: { type: "number" as const, description: "Item index to insert at (default: end)" },
          questions: { type: "array" as const, description: "Items in order", items: questionSchema },
        },
        required: ["account", "form_id", "questions"],
      },
      handler: async (args: { account: string; form_id: string; position?: number; questions: FormQuestion[] }) =>
        withScope(args.account, [SCOPE.drive, SCOPE.formsBody], scopes, async () => {
          if (!args.questions || args.questions.length === 0) throw new Error("questions must contain at least one question");
          const forms = await getClient(args.account);
          const current = (await forms.forms.get({ formId: args.form_id } as never)).data as forms_v1.Schema$Form;
          const count = (current.items ?? []).length;
          const start = args.position ?? count;
          if (!Number.isInteger(start) || start < 0 || start > count) {
            throw new Error(`position must be an integer from 0 to ${count}`);
          }
          const requests = buildQuestionRequests(args.questions).map((request, i) => {
            const create = (request as { createItem: { location: { index: number } } }).createItem;
            create.location.index = start + i;
            return request;
          });
          await forms.forms.batchUpdate({ formId: args.form_id, requestBody: { requests } } as never);
          return asText({
            formId: args.form_id,
            added: requests.length,
            startIndex: start,
            itemCount: count + requests.length,
          });
        }),
    },
    {
      name: "forms_update_info",

      readOnly: false,
      description:
        "Change a form's title and/or description (updateFormInfo). Only the fields given change. " +
        "The Drive document title cannot be changed through batchUpdate. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          form_id: formId,
          title: { type: "string" as const, description: "New title shown to respondents" },
          description: { type: "string" as const, description: "New description" },
        },
        required: ["account", "form_id"],
      },
      handler: async (args: { account: string; form_id: string; title?: string; description?: string }) =>
        withScope(args.account, [SCOPE.drive, SCOPE.formsBody], scopes, async () => {
          const info: Record<string, string> = {};
          const fields: string[] = [];
          if (args.title !== undefined) {
            info.title = args.title;
            fields.push("title");
          }
          if (args.description !== undefined) {
            info.description = args.description;
            fields.push("description");
          }
          if (!fields.length) throw new Error("pass title, description or both");
          const forms = await getClient(args.account);
          const res = await forms.forms.batchUpdate({
            formId: args.form_id,
            requestBody: { requests: [{ updateFormInfo: { info, updateMask: fields.join(",") } }] },
          } as never);
          return asText(res.data);
        }),
    },
    {
      name: "forms_update_settings",

      readOnly: false,
      description:
        "Change a form's settings (updateSettings): quiz_mode turns grading on or off (false deletes all " +
        "question grading); email_collection is DO_NOT_COLLECT, VERIFIED (signed-in account) or " +
        "RESPONDER_INPUT (respondent types it). Only the given settings change. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          form_id: formId,
          quiz_mode: { type: "boolean" as const, description: "Turn quiz mode on (true) or off (false)" },
          email_collection: { type: "string" as const, description: EMAIL_COLLECTION_TYPES.join(", ") },
        },
        required: ["account", "form_id"],
      },
      handler: async (args: { account: string; form_id: string; quiz_mode?: boolean; email_collection?: string }) =>
        withScope(args.account, [SCOPE.drive, SCOPE.formsBody], scopes, async () => {
          const settings: Record<string, unknown> = {};
          const masks: string[] = [];
          if (args.quiz_mode !== undefined) {
            settings.quizSettings = { isQuiz: args.quiz_mode };
            masks.push("quizSettings.isQuiz");
          }
          if (args.email_collection !== undefined) {
            if (!EMAIL_COLLECTION_TYPES.includes(args.email_collection)) {
              throw new Error(`email_collection must be one of ${EMAIL_COLLECTION_TYPES.join(", ")}`);
            }
            settings.emailCollectionType = args.email_collection;
            masks.push("emailCollectionType");
          }
          if (!masks.length) throw new Error("pass quiz_mode, email_collection or both");
          const forms = await getClient(args.account);
          const res = await forms.forms.batchUpdate({
            formId: args.form_id,
            requestBody: { requests: [{ updateSettings: { settings, updateMask: masks.join(",") } }] },
          } as never);
          return asText(res.data);
        }),
    },
    {
      name: "forms_update_item",

      readOnly: false,
      description:
        "Replace the item at an index (updateItem). item is a Forms API Item object (raw shape, e.g. " +
        "{title, questionItem: {question: {required, textQuestion: {paragraph: false}}}}); update_mask lists the " +
        "fields to change, e.g. \"title,questionItem.question.required\". Read forms_get first for indexes and itemIds. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          form_id: formId,
          index,
          item: { type: "object" as const, description: "Forms API Item object (its itemId is kept when included)" },
          update_mask: { type: "string" as const, description: "Comma-separated field names to change" },
        },
        required: ["account", "form_id", "index", "item", "update_mask"],
      },
      handler: async (args: { account: string; form_id: string; index: number; item: Record<string, unknown>; update_mask: string }) =>
        withScope(args.account, [SCOPE.drive, SCOPE.formsBody], scopes, async () => {
          if (!Number.isInteger(args.index) || args.index < 0) throw new Error("index must be a non-negative integer");
          if (!args.item || typeof args.item !== "object") throw new Error("item must be a Forms API Item object");
          if (!args.update_mask?.trim()) throw new Error("update_mask names the fields to change");
          const forms = await getClient(args.account);
          const res = await forms.forms.batchUpdate({
            formId: args.form_id,
            requestBody: {
              requests: [{ updateItem: { item: args.item, location: { index: args.index }, updateMask: args.update_mask } }],
            },
          } as never);
          return asText(res.data);
        }),
    },
    {
      name: "forms_move_item",

      readOnly: false,
      description:
        "Move the item at from_index so it sits at to_index (moveItem). Read forms_get first for indexes. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          form_id: formId,
          from_index: { type: "number" as const, description: "Current item index" },
          to_index: { type: "number" as const, description: "Index to move it to" },
        },
        required: ["account", "form_id", "from_index", "to_index"],
      },
      handler: async (args: { account: string; form_id: string; from_index: number; to_index: number }) =>
        withScope(args.account, [SCOPE.drive, SCOPE.formsBody], scopes, async () => {
          for (const [label, value] of [["from_index", args.from_index], ["to_index", args.to_index]] as const) {
            if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
          }
          const forms = await getClient(args.account);
          const res = await forms.forms.batchUpdate({
            formId: args.form_id,
            requestBody: {
              requests: [
                {
                  moveItem: {
                    originalLocation: { index: args.from_index },
                    newLocation: { index: args.to_index },
                  },
                },
              ],
            },
          } as never);
          return asText(res.data);
        }),
    },
    {
      name: "forms_delete_item",

      readOnly: false,
      description:
        "Delete the item at an index (deleteItem). Removes the question and the link from existing answers to it; " +
        "the form's responses themselves are kept. Read forms_get first for indexes. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: { account, form_id: formId, index },
        required: ["account", "form_id", "index"],
      },
      handler: async (args: { account: string; form_id: string; index: number }) =>
        withScope(args.account, [SCOPE.drive, SCOPE.formsBody], scopes, async () => {
          if (!Number.isInteger(args.index) || args.index < 0) throw new Error("index must be a non-negative integer");
          const forms = await getClient(args.account);
          const res = await forms.forms.batchUpdate({
            formId: args.form_id,
            requestBody: { requests: [{ deleteItem: { location: { index: args.index } } }] },
          } as never);
          return asText(res.data);
        }),
    },
    {
      name: "forms_batch_update",

      readOnly: false,
      description:
        "Apply raw Forms API batchUpdate requests: createItem, updateItem (with updateMask), " +
        "moveItem, deleteItem (destructive: removes the question and the answers' link to it), " +
        "updateFormInfo, updateSettings. Applied atomically in order. Read forms_get first for " +
        "item indexes. include_form_in_response returns the updated form. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          form_id: formId,
          requests: {
            type: "array" as const,
            description: "Forms API Request objects.",
            items: { type: "object" as const },
          },
          include_form_in_response: { type: "boolean" as const, description: "Return the updated form (default false)" },
        },
        required: ["account", "form_id", "requests"],
      },
      handler: async (args: {
        account: string;
        form_id: string;
        requests: Record<string, unknown>[];
        include_form_in_response?: boolean;
      }) =>
        withScope(args.account, [SCOPE.drive, SCOPE.formsBody], scopes, async () => {
          if (!args.requests || args.requests.length === 0) {
            throw new Error("requests must contain at least one Forms API request");
          }
          const forms = await getClient(args.account);
          const res = await forms.forms.batchUpdate({
            formId: args.form_id,
            requestBody: {
              requests: args.requests,
              ...(args.include_form_in_response ? { includeFormInResponse: true } : {}),
            },
          } as never);
          return asText(res.data);
        }),
    },
    {
      name: "forms_watch_create",

      readOnly: false,
      description:
        "Watch a form for changes (SCHEMA: edits to questions and settings) or new submissions (RESPONSES). " +
        "Notifications are published to a Cloud Pub/Sub topic that must already exist in the calling project " +
        "as projects/<project>/topics/<topic>, and must grant publish rights to " +
        "forms-notifications@system.gserviceaccount.com. A watch expires after seven days; use forms_watch_renew. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          form_id: formId,
          topic_name: { type: "string" as const, description: "Full Pub/Sub topic name: projects/<project>/topics/<topic>" },
          event_type: { type: "string" as const, description: "SCHEMA or RESPONSES" },
          watch_id: { type: "string" as const, description: "Optional id: 4-63 chars, lowercase letters, digits, hyphens" },
        },
        required: ["account", "form_id", "topic_name", "event_type"],
      },
      handler: async (args: { account: string; form_id: string; topic_name: string; event_type: string; watch_id?: string }) =>
        withScope(args.account, [SCOPE.drive, SCOPE.formsBody], scopes, async () => {
          if (!/^projects\/[^/]+\/topics\/[^/]+$/.test(args.topic_name)) {
            throw new Error("topic_name must be a full Pub/Sub name: projects/<project>/topics/<topic>");
          }
          if (!["SCHEMA", "RESPONSES"].includes(args.event_type)) throw new Error("event_type must be SCHEMA or RESPONSES");
          const forms = await getClient(args.account);
          const res = await forms.forms.watches.create({
            formId: args.form_id,
            requestBody: {
              watch: { eventType: args.event_type, target: { topic: { topicName: args.topic_name } } },
              ...(args.watch_id ? { watchId: args.watch_id } : {}),
            },
          } as never);
          return asText(res.data);
        }),
    },
    {
      name: "forms_watch_list",

      readOnly: true,
      description:
        "List the watches this project holds on a form: id, eventType, target topic, state, expireTime and any " +
        "errorType. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: { account, form_id: formId },
        required: ["account", "form_id"],
      },
      handler: async (args: { account: string; form_id: string }) =>
        withScope(args.account, [SCOPE.drive, SCOPE.driveReadonly, SCOPE.formsBody, SCOPE.formsBodyReadonly, SCOPE.formsResponses], scopes, async () => {
          const forms = await getClient(args.account);
          const res = await forms.forms.watches.list({ formId: args.form_id } as never);
          return asText(res.data);
        }),
    },
    {
      name: "forms_watch_renew",

      readOnly: false,
      description:
        "Extend a form watch by seven days from now (watches.renew). Also reactivates a SUSPENDED watch and clears " +
        "its errorType. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: { account, form_id: formId, watch_id: { type: "string" as const, description: "Watch id (from forms_watch_list)" } },
        required: ["account", "form_id", "watch_id"],
      },
      handler: async (args: { account: string; form_id: string; watch_id: string }) =>
        withScope(args.account, [SCOPE.drive, SCOPE.formsBody], scopes, async () => {
          const forms = await getClient(args.account);
          const res = await forms.forms.watches.renew({ formId: args.form_id, watchId: args.watch_id } as never);
          return asText(res.data);
        }),
    },
    {
      name: "forms_watch_delete",

      readOnly: false,
      description:
        "Delete a form watch so its Pub/Sub notifications stop. " + accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: { account, form_id: formId, watch_id: { type: "string" as const, description: "Watch id (from forms_watch_list)" } },
        required: ["account", "form_id", "watch_id"],
      },
      handler: async (args: { account: string; form_id: string; watch_id: string }) =>
        withScope(args.account, [SCOPE.drive, SCOPE.formsBody], scopes, async () => {
          const forms = await getClient(args.account);
          const res = await forms.forms.watches.delete({ formId: args.form_id, watchId: args.watch_id } as never);
          return asText(res.data ?? { deleted: true, watchId: args.watch_id });
        }),
    },
    {
      name: "forms_list_responses",

      readOnly: true,
      description:
        "List a Google Form's responses with answers keyed by question title: responseId, " +
        "submitted time, respondentEmail (when collected) and answers. since filters to " +
        `responses submitted after an ISO date/time. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          form_id: formId,
          since: { type: "string" as const, description: "Optional: only responses after this date/time" },
          max_results: { type: "number" as const, description: "Maximum responses (default 500)" },
        },
        required: ["account", "form_id"],
      },
      handler: async (args: { account: string; form_id: string; since?: string; max_results?: number }) =>
        withScope(args.account, [SCOPE.drive, SCOPE.driveReadonly, SCOPE.formsResponses, SCOPE.formsBody], scopes, async () => {
          const forms = await getClient(args.account);
          const form = (await forms.forms.get({ formId: args.form_id } as never)).data as forms_v1.Schema$Form;
          let filter: string | undefined;
          if (args.since) {
            const parsed = new Date(args.since);
            if (Number.isNaN(parsed.getTime())) throw new Error(`since is not a date: ${args.since}`);
            filter = `timestamp > ${parsed.toISOString()}`;
          }
          const limit = args.max_results ?? 500;
          const responses: forms_v1.Schema$FormResponse[] = [];
          let pageToken: string | undefined;
          do {
            const res = await forms.forms.responses.list({
              formId: args.form_id,
              pageSize: Math.min(5000, limit),
              pageToken,
              ...(filter ? { filter } : {}),
            } as never);
            const data = res.data as forms_v1.Schema$ListFormResponsesResponse;
            responses.push(...(data.responses ?? []));
            pageToken = data.nextPageToken ?? undefined;
          } while (pageToken && responses.length < limit);
          const flat = flattenResponses(form, responses.slice(0, limit));
          flat.sort((a, b) => String(a.submitted ?? "").localeCompare(String(b.submitted ?? "")));
          return asText({ formId: args.form_id, title: form.info?.title, count: flat.length, responses: flat });
        }),
    },
    {
      name: "forms_get_response",

      readOnly: true,
      description:
        "Read one response to a Google Form by response id (from forms_list_responses), with " +
        "answers keyed by question title. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          form_id: formId,
          response_id: { type: "string" as const, description: "Response ID" },
        },
        required: ["account", "form_id", "response_id"],
      },
      handler: async (args: { account: string; form_id: string; response_id: string }) =>
        withScope(args.account, [SCOPE.drive, SCOPE.driveReadonly, SCOPE.formsResponses, SCOPE.formsBody], scopes, async () => {
          const forms = await getClient(args.account);
          const form = (await forms.forms.get({ formId: args.form_id } as never)).data as forms_v1.Schema$Form;
          const res = await forms.forms.responses.get({ formId: args.form_id, responseId: args.response_id } as never);
          const [flat] = flattenResponses(form, [res.data as forms_v1.Schema$FormResponse]);
          return asText({ formId: args.form_id, title: form.info?.title, response: flat });
        }),
    },
  ];
}

export const formsTools = createFormsTools();
