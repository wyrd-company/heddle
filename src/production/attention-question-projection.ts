// ---
// relationships:
//   implements: heddle
// ---

import {
  MAXIMUM_CONSOLE_ATTENTION_IDENTIFIER_LENGTH,
  type ConsoleAttentionQuestion,
} from "../console/index.js";

export type AttentionPayload = Record<string, unknown>;

export const requiredAttentionString = (
  payload: AttentionPayload,
  field: string,
  attentionId: string,
): string => {
  const value = payload[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Attention '${attentionId}' has no valid ${field}`);
  }
  return value;
};

export const requiredAttentionIdentifier = (
  payload: AttentionPayload,
  field: string,
  attentionId: string,
): string => {
  const value = requiredAttentionString(payload, field, attentionId);
  if (value.length > MAXIMUM_CONSOLE_ATTENTION_IDENTIFIER_LENGTH) {
    throw new Error(`Attention '${attentionId}' has no valid ${field}`);
  }
  return value;
};

const record = (value: unknown, attentionId: string, name: string) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Attention '${attentionId}' has malformed ${name}`);
  }
  return value as AttentionPayload;
};

const optionalString = (
  payload: AttentionPayload,
  field: string,
  attentionId: string,
): string | undefined => {
  if (payload[field] === undefined) return undefined;
  return requiredAttentionString(payload, field, attentionId);
};

const questions = (
  value: unknown,
  attentionId: string,
): ConsoleAttentionQuestion[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Attention '${attentionId}' has no questions`);
  }
  const questionIds = new Set<string>();
  return value.map((item) => {
    const question = record(item, attentionId, "questions");
    if (
      question["multiSelect"] !== undefined &&
      typeof question["multiSelect"] !== "boolean"
    ) {
      throw new Error(`Attention '${attentionId}' has malformed questions`);
    }
    const id = requiredAttentionString(question, "id", attentionId);
    if (questionIds.has(id)) {
      throw new Error(`Attention '${attentionId}' repeats question '${id}'`);
    }
    questionIds.add(id);
    const rawOptions = question["options"];
    if (!Array.isArray(rawOptions)) {
      throw new Error(`Attention '${attentionId}' has malformed options`);
    }
    const header = optionalString(question, "header", attentionId);
    const optionLabels = new Set<string>();
    return {
      ...(header === undefined ? {} : { header }),
      id,
      multiSelect: (question["multiSelect"] as boolean | undefined) ?? false,
      options: rawOptions.map((item) => {
        const option = record(item, attentionId, "options");
        const label = requiredAttentionString(option, "label", attentionId);
        if (optionLabels.has(label)) {
          throw new Error(
            `Attention '${attentionId}' repeats option '${label}'`,
          );
        }
        optionLabels.add(label);
        const description = optionalString(option, "description", attentionId);
        return { ...(description === undefined ? {} : { description }), label };
      }),
      question: requiredAttentionString(question, "question", attentionId),
    };
  });
};

export const escalationQuestions = questions;
export const t3Questions = questions;
