// ---
// relationships:
//   implements: heddle
// ---

import { createHash } from "node:crypto";
import { URL } from "node:url";

import type {
  ConsoleAttention,
  ConsoleAttentionAction,
  ConsoleAttentionActionAnswers,
  ConsoleAttentionActionRequest,
  ConsoleAttentionScope,
} from "./types.js";

export const MAXIMUM_CONSOLE_ATTENTION_IDENTIFIER_LENGTH = 128;

export const CONSOLE_ATTENTION_KIND_LABELS = {
  approval: "Approval request",
  "blueprint-repository": "Blueprint repository",
  ended: "Session ended",
  escalation: "Escalation",
  failed: "Session failed",
  "epic-acceptance": "Epic acceptance",
  "incident-production-mutation-approval":
    "Incident production mutation approval",
  "lifecycle-resolution": "Lifecycle resolution",
  "production-error": "Production error",
  stalled: "Session stalled",
  "stale-instance": "Stale instance",
  "user-input": "User input",
} as const;

const readableKind = (kind: string): string =>
  kind
    .split("-")
    .filter((part) => part !== "")
    .map((part, index) =>
      index === 0 ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part,
    )
    .join(" ");

export const consoleAttentionHeading = (
  attention: Pick<ConsoleAttention, "kind" | "scope">,
): string => {
  const kind =
    CONSOLE_ATTENTION_KIND_LABELS[
      attention.kind as keyof typeof CONSOLE_ATTENTION_KIND_LABELS
    ] ?? readableKind(attention.kind);
  const scope =
    attention.scope === "all"
      ? "All work"
      : attention.scope.startsWith("epic:")
        ? `Epic ${attention.scope.slice("epic:".length)}`
        : `Task ${attention.scope.slice("task:".length)}`;
  return `${kind} — ${scope}`;
};

const identifier = (value: unknown, name: string): string => {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > MAXIMUM_CONSOLE_ATTENTION_IDENTIFIER_LENGTH
  ) {
    throw new TypeError(
      `${name} must be a non-empty string of at most ${MAXIMUM_CONSOLE_ATTENTION_IDENTIFIER_LENGTH} characters`,
    );
  }
  return value;
};

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export const consoleAttentionFingerprint = (
  attention: Omit<ConsoleAttention, "fingerprint">,
): string => createHash("sha256").update(canonical(attention)).digest("hex");

export const createConsoleAttention = (
  attention: Omit<ConsoleAttention, "fingerprint" | "heading">,
): ConsoleAttention => {
  const state = {
    ...attention,
    heading: consoleAttentionHeading(attention),
  };
  return {
    ...state,
    fingerprint: consoleAttentionFingerprint(state),
  };
};

export const assertConsoleAttentionFingerprint = (
  attention: ConsoleAttention,
): void => {
  const { fingerprint, ...state } = attention;
  if (fingerprint !== consoleAttentionFingerprint(state)) {
    throw new Error(
      `Attention '${attention.attentionId}' has an invalid state fingerprint`,
    );
  }
};

export const validateConsoleAttentionCatalog = (
  attention: ConsoleAttention[],
  actionsAvailable: boolean,
): void => {
  const identities = new Set<string>();
  for (const entry of attention) {
    identifier(entry.attentionId, "attentionId");
    if (identities.has(entry.attentionId)) {
      throw new Error(
        `Attention identity '${entry.attentionId}' is duplicated`,
      );
    }
    identities.add(entry.attentionId);
    assertConsoleAttentionFingerprint(entry);
    if (entry.heading !== consoleAttentionHeading(entry)) {
      throw new Error(
        `Attention '${entry.attentionId}' has a heading that does not match its kind and scope`,
      );
    }
    const actionIds = new Set<string>();
    for (const action of entry.actions) {
      identifier(action.actionId, "actionId");
      if (actionIds.has(action.actionId)) {
        throw new Error(
          `Attention '${entry.attentionId}' repeats action '${action.actionId}'`,
        );
      }
      actionIds.add(action.actionId);
    }
    if (!actionsAvailable && entry.actions.length > 0) {
      throw new ConsoleAttentionActionsUnavailableError(
        "Console attention actions are not active in this deployment composition",
      );
    }
  }
};

const requireRecord = (
  value: unknown,
  name: string,
): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
};

const questionAnswers = (
  value: unknown,
  action: ConsoleAttentionAction,
): ConsoleAttentionActionAnswers => {
  if (action.input.kind !== "questions") {
    throw new TypeError(`Action '${action.actionId}' does not accept answers`);
  }
  const answers = requireRecord(value, "answers");
  const expected = new Set(action.input.questions.map(({ id }) => id));
  if (
    Object.keys(answers).length !== expected.size ||
    Object.keys(answers).some((id) => !expected.has(id))
  ) {
    throw new TypeError(
      "Answers must name every offered question exactly once",
    );
  }
  const result: ConsoleAttentionActionAnswers = {};
  for (const question of action.input.questions) {
    const answer = requireRecord(
      answers[question.id],
      `Answer for '${question.id}'`,
    );
    const { selectedOptions: selected, text, reasoning } = answer;
    if (
      Object.keys(answer).some(
        (key) => !["selectedOptions", "text", "reasoning"].includes(key),
      ) ||
      !Array.isArray(selected) ||
      selected.some((item) => typeof item !== "string") ||
      typeof text !== "string" ||
      typeof reasoning !== "string" ||
      reasoning.trim() === ""
    ) {
      throw new TypeError(
        `Answer for '${question.id}' requires selectedOptions, text, and nonempty reasoning`,
      );
    }
    if (selected.length > 0 === (text.trim() !== "")) {
      throw new TypeError(
        `Answer for '${question.id}' must supply selected options or text exclusively`,
      );
    }
    if (!question.multiSelect && selected.length > 1) {
      throw new TypeError(
        `Answer for '${question.id}' must select at most one option`,
      );
    }
    const offered = new Set(question.options.map(({ label }) => label));
    if (new Set(selected).size !== selected.length) {
      throw new TypeError(`Answer for '${question.id}' repeats an option`);
    }
    if (selected.some((item) => !offered.has(item as string))) {
      throw new TypeError(
        `Answer for '${question.id}' does not name an offered option`,
      );
    }
    Object.defineProperty(result, question.id, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: { selectedOptions: selected as string[], text, reasoning },
    });
  }
  return result;
};

export const parseConsoleAttentionActionRequest = (
  value: unknown,
  action: ConsoleAttentionAction,
): ConsoleAttentionActionRequest => {
  const body = requireRecord(value, "request body");
  const allowed = new Set(
    action.input.kind === "questions"
      ? ["answers", "fingerprint"]
      : ["fingerprint"],
  );
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new TypeError("request body contains an unsupported field");
  }
  const fingerprint = identifier(body["fingerprint"], "fingerprint");
  if (action.input.kind === "questions") {
    return {
      answers: questionAnswers(body["answers"], action),
      fingerprint,
    };
  }
  return { fingerprint };
};

export const consoleAttentionDeepLink = (
  baseUrl: string,
  attention: Pick<ConsoleAttention, "attentionId" | "scope">,
): string => {
  const url = new URL("/", baseUrl);
  if (attention.scope.startsWith("task:")) {
    url.searchParams.set("view", "lifecycle");
    url.searchParams.set("task", attention.scope.slice("task:".length));
    url.searchParams.set("scope", "all");
  } else {
    url.searchParams.set("scope", attention.scope);
  }
  url.searchParams.set("attention", attention.attentionId);
  return url.href;
};

export const isConsoleAttentionScope = (
  value: string,
): value is ConsoleAttentionScope =>
  value === "all" || /^(epic|task):[1-9][0-9]*$/.test(value);

export class ConsoleAttentionConflictError extends Error {}

export class ConsoleAttentionActionsUnavailableError extends Error {}
