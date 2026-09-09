// ---
// relationships:
//   implements: heddle
// ---

import { createHash } from "node:crypto";

import { z } from "zod";

const identifier = z.string().trim().min(1).max(128);

const choiceEscalationQuestionSchema = z
  .object({
    id: identifier,
    kind: z.literal("choice").optional(),
    options: z
      .array(
        z
          .object({
            description: z.string().trim().min(1).max(2_000),
            id: identifier,
            label: z.string().trim().min(1).max(200),
          })
          .strict(),
      )
      .min(2)
      .max(20),
    prompt: z.string().trim().min(1).max(4_000),
  })
  .strict();

const valueValidationSchema = z
  .object({
    maxLength: z.number().int().min(1).max(4_000),
    minLength: z.number().int().min(0).max(4_000).default(1),
    pattern: z
      .string()
      .max(1_000)
      .refine((pattern) => {
        try {
          new RegExp(pattern, "u");
          return true;
        } catch {
          return false;
        }
      }, "Value validation pattern must be a valid regular expression")
      .optional(),
  })
  .strict()
  .refine(
    ({ maxLength, minLength }) => minLength <= maxLength,
    "Value validation minimum length must not exceed its maximum length",
  );

const valueEscalationQuestionSchema = z
  .object({
    id: identifier,
    kind: z.literal("value"),
    prompt: z.string().trim().min(1).max(4_000),
    validation: valueValidationSchema,
  })
  .strict();

export const escalationQuestionSchema = z.union([
  choiceEscalationQuestionSchema,
  valueEscalationQuestionSchema,
]);

export const escalationInputSchema = z
  .object({
    escalationId: identifier,
    questions: z.array(escalationQuestionSchema).min(1).max(20),
  })
  .strict();

export const escalationAnswerSchema = z
  .object({
    answers: z.record(identifier, identifier),
    escalationId: identifier,
    ownerSessionKey: identifier,
    prose: z.string().trim().min(1).max(4_000).optional(),
  })
  .strict();

export const escalationAnsweringAuthoritySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("operator") }).strict(),
  z.object({ kind: z.literal("session"), sessionKey: identifier }).strict(),
]);

export const answeredEscalationSchema = escalationAnswerSchema.extend({
  answeredBy: escalationAnsweringAuthoritySchema,
});

export type EscalationQuestion = z.infer<typeof escalationQuestionSchema>;
export type EscalationInput = z.infer<typeof escalationInputSchema>;
export type EscalationAnswerInput = z.infer<typeof escalationAnswerSchema>;
export type EscalationAnswers = Record<string, string>;
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
  questions: EscalationQuestion[];
  stage: string;
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
  prose?: string;
};

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
    if (question.kind === "value") continue;
    const optionIds = new Set<string>();
    for (const option of question.options) {
      if (optionIds.has(option.id)) {
        throw new TypeError(
          `Escalation question '${question.id}' repeats option ID '${option.id}'`,
        );
      }
      optionIds.add(option.id);
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
      "Escalation answer must select one option per question",
    );
  }
  for (const question of opened.questions) {
    const selected = answers[question.id];
    if (question.kind === "value") {
      const { maxLength, minLength, pattern } = question.validation;
      if (
        selected === undefined ||
        selected.length < minLength ||
        selected.length > maxLength ||
        (pattern !== undefined && !new RegExp(pattern, "u").test(selected))
      ) {
        throw new TypeError(
          `Escalation answer for '${question.id}' does not satisfy its value validation`,
        );
      }
      continue;
    }
    if (!question.options.some(({ id }) => id === selected)) {
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
  opened.questions.every(({ id }) => left.answers[id] === right.answers[id]) &&
  Object.keys(left.answers).length === Object.keys(right.answers).length &&
  left.prose === right.prose &&
  JSON.stringify(left.answeredBy) === JSON.stringify(right.answeredBy);
