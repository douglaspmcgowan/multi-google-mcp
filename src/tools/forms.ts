import type { forms_v1 } from "@googleapis/forms";
import { getAuthenticatedClient } from "../auth.js";
import { getAccountNames } from "../config.js";
import { SCOPE, grantedScopes, withScope, type ScopeLookup } from "../scopes.js";

type FormsClient = forms_v1.Forms;

async function getForms(account: string): Promise<FormsClient> {
  const { forms } = await import("@googleapis/forms");
  return forms({ version: "v1", auth: getAuthenticatedClient(account) as never });
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
  title: string;
  /** short_text, paragraph, multiple_choice, checkboxes, dropdown, scale, date, time */
  type: string;
  description?: string;
  required?: boolean;
  options?: string[];
  low?: number;
  high?: number;
  low_label?: string;
  high_label?: string;
}

const CHOICE_TYPES: Record<string, string> = {
  multiple_choice: "RADIO",
  checkboxes: "CHECKBOX",
  dropdown: "DROP_DOWN",
};

export const QUESTION_TYPES = ["short_text", "paragraph", ...Object.keys(CHOICE_TYPES), "scale", "date", "time"];

/** One createItem request per question, placed in order. */
export function buildQuestionRequests(questions: FormQuestion[]): Record<string, unknown>[] {
  return questions.map((q, index) => {
    if (!q.title?.trim()) throw new Error(`question ${index} has no title`);
    const question: Record<string, unknown> = { required: !!q.required };
    if (q.type === "short_text" || q.type === "paragraph") {
      question.textQuestion = { paragraph: q.type === "paragraph" };
    } else if (q.type in CHOICE_TYPES) {
      const options = (q.options ?? []).map((o) => o.trim()).filter(Boolean);
      if (!options.length) throw new Error(`question ${index} (${q.type}) needs options`);
      question.choiceQuestion = { type: CHOICE_TYPES[q.type], options: options.map((value) => ({ value })) };
    } else if (q.type === "scale") {
      const low = q.low ?? 1;
      const high = q.high ?? 5;
      if (!(low === 0 || low === 1) || high < 2 || high > 10) {
        throw new Error(`question ${index} scale needs low 0 or 1 and high 2-10`);
      }
      question.scaleQuestion = {
        low,
        high,
        ...(q.low_label ? { lowLabel: q.low_label } : {}),
        ...(q.high_label ? { highLabel: q.high_label } : {}),
      };
    } else if (q.type === "date") {
      question.dateQuestion = { includeYear: true, includeTime: false };
    } else if (q.type === "time") {
      question.timeQuestion = { duration: false };
    } else {
      throw new Error(`question ${index} has unknown type ${q.type}; use one of ${QUESTION_TYPES.join(", ")}`);
    }
    return {
      createItem: {
        item: {
          title: q.title,
          ...(q.description ? { description: q.description } : {}),
          questionItem: { question },
        },
        location: { index },
      },
    };
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

/**
 * Google Forms tools. Forms created through the API after 2026-06-30 start
 * unpublished, so forms_create publishes explicitly unless publish=false.
 * The drive scope already satisfies these methods; forms.body and
 * forms.responses.readonly are also accepted.
 */
export function createFormsTools(
  getClient: (account: string) => FormsClient | Promise<FormsClient> = getForms,
  getAccounts: () => string[] = getAccountNames,
  scopes: ScopeLookup = grantedScopes
) {
  const account = { type: "string" as const, description: "Account label" };

  return [
    {
      name: "forms_create",
      description:
        "Create a Google Form with questions in one call. Question types: short_text, paragraph, " +
        "multiple_choice, checkboxes, dropdown (these three need options), scale (low 0/1, " +
        "high 2-10, labels), date, time. Published and accepting responses unless " +
        "publish=false. Returns formId, responderUri and the edit URL. " +
        accountDescription(getAccounts),
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          title: { type: "string" as const, description: "Form title shown to respondents" },
          document_title: { type: "string" as const, description: "Drive file name (default: title)" },
          description: { type: "string" as const, description: "Form description" },
          publish: { type: "boolean" as const, description: "Publish and accept responses (default true)" },
          questions: {
            type: "array" as const,
            description: "Questions in order",
            items: {
              type: "object" as const,
              properties: {
                title: { type: "string" as const, description: "Question text" },
                type: { type: "string" as const, description: QUESTION_TYPES.join(", ") },
                description: { type: "string" as const, description: "Help text" },
                required: { type: "boolean" as const, description: "Required answer" },
                options: { type: "array" as const, description: "Choices", items: { type: "string" as const } },
                low: { type: "number" as const, description: "Scale low (0 or 1)" },
                high: { type: "number" as const, description: "Scale high (2-10)" },
                low_label: { type: "string" as const, description: "Scale low label" },
                high_label: { type: "string" as const, description: "Scale high label" },
              },
              required: ["title", "type"],
            },
          },
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
          const formId = form.formId!;
          if (requests.length) {
            await forms.forms.batchUpdate({ formId, requestBody: { requests } } as never);
          }
          if (publish) {
            await forms.forms.setPublishSettings({
              formId,
              requestBody: {
                publishSettings: { publishState: { isPublished: true, isAcceptingResponses: true } },
                updateMask: "publishState",
              },
            } as never);
          }
          return asText({
            formId,
            title: args.title,
            published: publish,
            questions: (args.questions ?? []).length,
            responderUri: form.responderUri,
            editUrl: `https://docs.google.com/forms/d/${formId}/edit`,
          });
        }),
    },
    {
      name: "forms_list_responses",
      description:
        "List a Google Form's responses with answers keyed by question title: responseId, " +
        "submitted time, respondentEmail (when collected) and answers. since filters to " +
        `responses submitted after an ISO date/time. ${accountDescription(getAccounts)}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          account,
          form_id: { type: "string" as const, description: "Form ID (from the form's URL /forms/d/<id>/edit)" },
          since: { type: "string" as const, description: "Optional: only responses after this date/time" },
          max_results: { type: "number" as const, description: "Maximum responses (default 500)" },
        },
        required: ["account", "form_id"],
      },
      handler: async (args: { account: string; form_id: string; since?: string; max_results?: number }) =>
        withScope(args.account, [SCOPE.drive, SCOPE.formsResponses, SCOPE.formsBody], scopes, async () => {
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
  ];
}

export const formsTools = createFormsTools();
