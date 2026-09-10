// ---
// relationships:
//   implements: heddle
// ---

import { createHash } from "node:crypto";

import { z } from "zod";

const identifier = z.string().trim().min(1).max(128);
const harnessString = z
  .string()
  .refine((value) => value.trim() !== "", "Harness values must not be blank");

export const escalationQuestionSchema = z
  .object({
    id: harnessString,
    header: harnessString.optional(),
    multiSelect: z.boolean().default(false),
    options: z.array(
      z
        .object({
          description: harnessString.optional(),
          label: harnessString,
        })
        .strict(),
    ),
    question: harnessString,
  })
  .strict();

export const escalationInputSchema = z
  .object({
    escalationId: identifier,
    requestId: z.string().min(1),
    threadId: z.string().min(1),
    questions: z.array(escalationQuestionSchema).min(1).max(20),
  })
  .strict();

const answerEntrySchema = z
  .object({
    selectedOptions: z.array(z.string().min(1)),
    text: z.string(),
    reasoning: harnessString,
  })
  .strict();

// Zod records discard __proto__. Native question IDs are data, so validate the
// original own entries without rewriting their keys. Publish the same entry
// schema to MCP clients that the runtime validator uses.
const answerSetSchema = z
  .unknown()
  .superRefine((value, context) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      context.addIssue({
        code: "custom",
        message: "Answers must be a keyed object",
      });
      return;
    }
    for (const key of Reflect.ownKeys(value)) {
      const keyResult = harnessString.safeParse(key);
      if (!keyResult.success) {
        context.addIssue({
          code: "custom",
          message: "Answer keys must be nonblank question IDs",
        });
        continue;
      }
      const result = answerEntrySchema.safeParse(Reflect.get(value, key));
      if (!result.success)
        for (const issue of result.error.issues) {
          context.addIssue({ ...issue, path: [keyResult.data, ...issue.path] });
        }
    }
  })
  .meta(
    z.toJSONSchema(z.record(harnessString, answerEntrySchema)),
  ) as z.ZodType<Record<string, z.infer<typeof answerEntrySchema>>>;

export const escalationAnswerSchema = z
  .object({
    answers: answerSetSchema,
    escalationId: identifier,
    ownerSessionKey: identifier,
    prose: z.string().trim().min(1).max(4_000).optional(),
  })
  .strict();

export const escalationAnsweringAuthoritySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("operator") }).strict(),
  z.object({ kind: z.literal("session"), sessionKey: identifier }).strict(),
  z
    .object({ kind: z.literal("adjudication"), sessionKey: identifier })
    .strict(),
]);

export const adjudicationEvidenceSchema = z
  .object({
    cause: z.string().trim().min(1).max(4_000),
    modelSlug: identifier.optional(),
    reasoning: z.string().trim().min(1).max(4_000).optional(),
  })
  .strict();

export const answeredEscalationSchema = escalationAnswerSchema.extend({
  answeredBy: escalationAnsweringAuthoritySchema,
  modelSlug: identifier.optional(),
});

export type EscalationQuestion = z.infer<typeof escalationQuestionSchema>;
export type EscalationInput = z.infer<typeof escalationInputSchema>;
export type EscalationAnswerInput = z.infer<typeof escalationAnswerSchema>;
export type EscalationAnswers = EscalationAnswerInput["answers"];
export type EscalationResult = {
  awaitingAnswer: boolean;
  escalationId: string;
};

export type EscalationAnsweringAuthority = z.infer<
  typeof escalationAnsweringAuthoritySchema
>;

export type EscalationAttention = {
  attentionId: string;
  escalationId: string;
  instanceId: string;
  openedAt: string;
  ownerSessionKey: string;
  requestId: string;
  threadId: string;
  questions: EscalationQuestion[];
  stage: string;
  adjudication?: z.infer<typeof adjudicationEvidenceSchema>;
};

export type PendingEscalation = EscalationAttention & {
  answeringAuthority: EscalationAnsweringAuthority;
  parentSessionKey?: string;
};

export type ParentEscalation = EscalationAttention & {
  parentSessionKey: string;
};

export type SessionEscalation = PendingEscalation & {
  answeringAuthority: Extract<
    EscalationAnsweringAuthority,
    { kind: "session" }
  >;
};

export type AnsweredEscalation = {
  answers: EscalationAnswers;
  answeredBy: EscalationAnsweringAuthority;
  escalationId: string;
  ownerSessionKey: string;
  modelSlug?: string;
  prose?: string;
};

export const harnessAnswers = (
  answers: EscalationAnswers,
): Record<string, string | string[]> =>
  Object.fromEntries(
    Object.entries(answers).map(([id, answer]) => [
      id,
      answer.text.trim() === "" ? answer.selectedOptions : answer.text,
    ]),
  );

export const renderQuestionSet = (opened: EscalationAttention): string =>
  [
    `Question set ${opened.escalationId} from session ${opened.ownerSessionKey} requires an answer.`,
    `Use the Heddle answer tool with escalationId=${JSON.stringify(opened.escalationId)}, ownerSessionKey=${JSON.stringify(opened.ownerSessionKey)}, and answers keyed by question ID.`,
    "Each answer requires selectedOptions (labels), text, and reasoning. Supply either selected options or text, never both. Answer every question in one call. Do not stop or advance while an answer is owed.",
    ...opened.questions.map((question) =>
      [
        `Question ID: ${question.id}`,
        question.question,
        question.multiSelect
          ? "Select one or more options, or give text instead."
          : "Select one option, or give text instead.",
        ...question.options.map(
          (option) =>
            `- ${option.label}${option.description === undefined ? "" : `: ${option.description}`}`,
        ),
        ...(question.options.length === 0
          ? ["There are no options; give a text answer."]
          : []),
      ].join("\n"),
    ),
  ].join("\n\n");

export const adjudicationSessionKey = (attentionId: string): string =>
  `adjudication:${attentionId.slice("escalation:".length)}`;

export const escalationKey = (
  instanceId: string,
  ownerSessionKey: string,
  escalationId: string,
): string => JSON.stringify([instanceId, ownerSessionKey, escalationId]);

export const escalationAttentionId = (
  instanceId: string,
  ownerSessionKey: string,
  escalationId: string,
): string =>
  `escalation:${createHash("sha256")
    .update(escalationKey(instanceId, ownerSessionKey, escalationId))
    .digest("hex")}`;

export const validateQuestions = (questions: EscalationQuestion[]): void => {
  const questionIds = new Set<string>();
  for (const question of questions) {
    if (questionIds.has(question.id)) {
      throw new TypeError(`Escalation repeats question ID '${question.id}'`);
    }
    questionIds.add(question.id);
    const optionIds = new Set<string>();
    for (const option of question.options) {
      if (optionIds.has(option.label)) {
        throw new TypeError(
          `Escalation question '${question.id}' repeats option label '${option.label}'`,
        );
      }
      optionIds.add(option.label);
    }
  }
};

export const validateAnswers = (
  opened: PendingEscalation,
  answers: EscalationAnswers,
): void => {
  const expected = new Set(opened.questions.map(({ id }) => id));
  const actual = Object.keys(answers);
  if (
    actual.length !== expected.size ||
    actual.some((id) => !expected.has(id))
  ) {
    throw new TypeError(
      "Escalation answer must answer every question exactly once",
    );
  }
  for (const question of opened.questions) {
    const answer =
      escalationAnswerSchema.shape.answers.parse(answers)[question.id]!;
    const selected = answer.selectedOptions;
    if (selected.length > 0 === answer.text.trim().length > 0) {
      throw new TypeError(
        `Answer '${question.id}' requires either selected options or text`,
      );
    }
    if (!question.multiSelect && selected.length > 1) {
      throw new TypeError(
        `Answer '${question.id}' permits only one selected option`,
      );
    }
    if (
      new Set(selected).size !== selected.length ||
      selected.some(
        (value) => !question.options.some(({ label }) => label === value),
      )
    ) {
      throw new TypeError(
        `Escalation answer for '${question.id}' does not name an offered option`,
      );
    }
  }
};

export const sameQuestions = (
  left: EscalationQuestion[],
  right: EscalationQuestion[],
): boolean => JSON.stringify(left) === JSON.stringify(right);

export const sameAnswers = (
  opened: PendingEscalation,
  left: AnsweredEscalation,
  right: AnsweredEscalation,
): boolean =>
  opened.questions.every(
    ({ id }) =>
      JSON.stringify(left.answers[id]) === JSON.stringify(right.answers[id]),
  ) &&
  Object.keys(left.answers).length === Object.keys(right.answers).length &&
  left.prose === right.prose &&
  JSON.stringify(left.answeredBy) === JSON.stringify(right.answeredBy);
