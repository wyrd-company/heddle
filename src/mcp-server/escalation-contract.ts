// ---
// relationships:
//   implements: heddle
// ---

import { createHash } from "node:crypto";

import { z } from "zod";

const identifier = z.string().trim().min(1).max(128);

export const escalationQuestionSchema = z
  .object({
    id: identifier,
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
  })
  .strict();

export type EscalationQuestion = z.infer<typeof escalationQuestionSchema>;
export type EscalationInput = z.infer<typeof escalationInputSchema>;
export type EscalationAnswerInput = z.infer<typeof escalationAnswerSchema>;
export type EscalationAnswers = Record<string, string>;
export type EscalationResult = {
  answers: EscalationAnswers;
  escalationId: string;
};

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
  parentSessionKey?: string;
};

export type ParentEscalation = EscalationAttention & {
  parentSessionKey: string;
};

export type AnsweredEscalation = {
  answers: EscalationAnswers;
  escalationId: string;
  ownerSessionKey: string;
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
  left: EscalationAnswers,
  right: EscalationAnswers,
): boolean =>
  opened.questions.every(({ id }) => left[id] === right[id]) &&
  Object.keys(left).length === Object.keys(right).length;
