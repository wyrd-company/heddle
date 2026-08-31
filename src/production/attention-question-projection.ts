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

const options = (value: unknown, attentionId: string): AttentionPayload[] => {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error(`Attention '${attentionId}' has malformed options`);
  }
  return value.map((item) => record(item, attentionId, "options"));
};

export const escalationQuestions = (
  value: unknown,
  attentionId: string,
): ConsoleAttentionQuestion[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Attention '${attentionId}' has no escalation questions`);
  }
  const questionIds = new Set<string>();
  return value.map((item) => {
    const question = record(item, attentionId, "questions");
    const id = requiredAttentionIdentifier(question, "id", attentionId);
    if (questionIds.has(id)) {
      throw new Error(`Attention '${attentionId}' repeats question '${id}'`);
    }
    questionIds.add(id);
    const optionIds = new Set<string>();
    return {
      id,
      multiSelect: false,
      options: options(question["options"], attentionId).map((option) => {
        const optionId = requiredAttentionIdentifier(option, "id", attentionId);
        if (optionIds.has(optionId)) {
          throw new Error(
            `Attention '${attentionId}' repeats option '${optionId}'`,
          );
        }
        optionIds.add(optionId);
        return {
          description: requiredAttentionString(
            option,
            "description",
            attentionId,
          ),
          label: requiredAttentionString(option, "label", attentionId),
          value: optionId,
        };
      }),
      prompt: requiredAttentionString(question, "prompt", attentionId),
    };
  });
};

export const t3Questions = (
  value: unknown,
  attentionId: string,
): ConsoleAttentionQuestion[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Attention '${attentionId}' has no user-input questions`);
  }
  const questionIds = new Set<string>();
  return value.map((item) => {
    const question = record(item, attentionId, "questions");
    if (typeof question["multiSelect"] !== "boolean") {
      throw new Error(`Attention '${attentionId}' has malformed questions`);
    }
    const header = question["header"];
    if (
      header !== undefined &&
      (typeof header !== "string" || header.trim() === "")
    ) {
      throw new Error(`Attention '${attentionId}' has malformed questions`);
    }
    const id = requiredAttentionIdentifier(question, "id", attentionId);
    if (questionIds.has(id)) {
      throw new Error(`Attention '${attentionId}' repeats question '${id}'`);
    }
    questionIds.add(id);
    const optionLabels = new Set<string>();
    return {
      ...(header === undefined ? {} : { header }),
      id,
      multiSelect: question["multiSelect"],
      options: options(question["options"], attentionId).map((option) => {
        const label = requiredAttentionString(option, "label", attentionId);
        if (optionLabels.has(label)) {
          throw new Error(
            `Attention '${attentionId}' repeats option '${label}'`,
          );
        }
        optionLabels.add(label);
        const description = option["description"];
        if (
          description !== undefined &&
          (typeof description !== "string" || description.trim() === "")
        ) {
          throw new Error(`Attention '${attentionId}' has malformed options`);
        }
        return {
          ...(description === undefined ? {} : { description }),
          label,
          value: label,
        };
      }),
      prompt: requiredAttentionString(question, "question", attentionId),
    };
  });
};
