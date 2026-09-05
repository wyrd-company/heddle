// ---
// relationships:
//   implements: heddle
// ---

import nunjucks from "nunjucks";

import type { JsonValue } from "../persistence/index.js";
import type { PinnedHandoffTemplate } from "./handoff-template-store.js";

export class HandoffRenderError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "HandoffRenderError";
  }
}

export type HandoffRenderInput = {
  correlationToken: string;
  driver: string;
  handoff: string;
  instanceId: string;
  sessionKey: string;
  stage: string;
  task: JsonValue;
  taskId: number;
  template: PinnedHandoffTemplate;
};

export const measuredMcpDrivers = [
  "claudeAgent",
  "codex",
  "cursor",
  "grok",
  "opencode",
] as const;

export type MeasuredHandoffDriver = (typeof measuredMcpDrivers)[number];

export type HandoffAuthenticationBinding = {
  driver: MeasuredHandoffDriver;
  format: "heddle.handoff-authentication-binding";
  policy: "external-provider-session-v1";
  version: 1;
};

export const isHandoffAuthenticationBinding = (
  value: JsonValue | undefined,
): value is HandoffAuthenticationBinding =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === 4 &&
  measuredMcpDrivers.some((driver) => value["driver"] === driver) &&
  value["format"] === "heddle.handoff-authentication-binding" &&
  value["policy"] === "external-provider-session-v1" &&
  value["version"] === 1;

export const resolveHandoffAuthenticationBinding = (
  driver: string,
): HandoffAuthenticationBinding => {
  if (!measuredMcpDrivers.some((measuredDriver) => measuredDriver === driver)) {
    throw new HandoffRenderError(
      `Driver '${driver}' has no measured Heddle MCP authentication policy`,
    );
  }
  return {
    driver: driver as HandoffAuthenticationBinding["driver"],
    format: "heddle.handoff-authentication-binding",
    policy: "external-provider-session-v1",
    version: 1,
  };
};

export const resolveEffectiveHandoffDriver = (
  modelSelectionInstanceId: string,
  providerContextDriver: string,
): MeasuredHandoffDriver => {
  const selected = resolveHandoffAuthenticationBinding(
    modelSelectionInstanceId,
  ).driver;
  const contextual = resolveHandoffAuthenticationBinding(
    providerContextDriver,
  ).driver;
  if (selected !== contextual) {
    throw new HandoffRenderError(
      "T3 model selection and provider context must name the same measured Heddle MCP authentication driver",
    );
  }
  return selected;
};

export const handoffAuthenticationBindingsAgree = (
  stored: JsonValue | undefined,
  current: HandoffAuthenticationBinding,
): stored is HandoffAuthenticationBinding =>
  isHandoffAuthenticationBinding(stored) &&
  stored.driver === current.driver &&
  stored.format === current.format &&
  stored.policy === current.policy &&
  stored.version === current.version;

export const composeSystemPrompt = (
  systemPrompt: string,
  renderedHandoff: string,
  correlationToken: string,
): string => {
  if (systemPrompt.trim() === "") {
    throw new HandoffRenderError("System prompt must not be empty");
  }
  if (systemPrompt.includes(correlationToken)) {
    throw new HandoffRenderError(
      "System prompt must not contain the correlation token",
    );
  }
  return `${systemPrompt}\n\n${renderedHandoff}`;
};

export const assertComposedSystemPrompt = (
  systemPrompt: string,
  renderedDocument: string,
  correlationToken: string,
): void => {
  const prefix = `${systemPrompt}\n\n`;
  if (
    systemPrompt.trim() === "" ||
    systemPrompt.includes(correlationToken) ||
    !renderedDocument.startsWith(prefix) ||
    renderedDocument.includes(correlationToken)
  ) {
    throw new HandoffRenderError(
      "Stored rendered handoff does not match its system prompt",
    );
  }
};

const sortedJson = (value: JsonValue): JsonValue => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortedJson);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedJson(value[key]!)]),
  );
};

const environment = (): nunjucks.Environment => {
  const result = new nunjucks.Environment(undefined, {
    autoescape: false,
    throwOnUndefined: true,
    trimBlocks: false,
    lstripBlocks: false,
  });
  const filters = result as unknown as {
    filters: Record<string, unknown>;
  };
  delete filters.filters["random"];
  delete filters.filters["date"];
  result.addFilter("stableJson", (value: JsonValue) =>
    JSON.stringify(sortedJson(value), undefined, 2),
  );
  return result;
};

const parseHandoff = (serialized: string): Record<string, JsonValue> => {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new HandoffRenderError("Stored handoff is not valid JSON", error);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>)["format"] !== "heddle.stage-handoff" ||
    (value as Record<string, unknown>)["version"] !== 1 ||
    Object.hasOwn(value, "correlationToken")
  ) {
    throw new HandoffRenderError(
      "Stored handoff is not a canonical projection",
    );
  }
  return value as Record<string, JsonValue>;
};

const identityFrontMatter = (input: HandoffRenderInput): string => {
  resolveHandoffAuthenticationBinding(input.driver);
  const strings = [input.instanceId, input.sessionKey, input.stage];
  if (
    strings.some((value) => value.trim() === "") ||
    input.correlationToken.trim() === "" ||
    /\s/.test(input.correlationToken) ||
    !Number.isSafeInteger(input.taskId) ||
    input.taskId < 1
  ) {
    throw new HandoffRenderError("Rendered handoff identity is invalid");
  }
  return [
    "---",
    'format: "heddle.stage-handoff"',
    "version: 1",
    `instanceId: ${JSON.stringify(input.instanceId)}`,
    `sessionKey: ${JSON.stringify(input.sessionKey)}`,
    `taskId: ${input.taskId}`,
    `stage: ${JSON.stringify(input.stage)}`,
    "---",
    "",
  ].join("\n");
};

export const renderStageHandoff = (input: HandoffRenderInput): string => {
  const handoff = parseHandoff(input.handoff);
  const stage = handoff["stage"];
  if (
    typeof stage !== "object" ||
    stage === null ||
    Array.isArray(stage) ||
    stage["name"] !== input.stage ||
    stage["kind"] !== input.template.kind
  ) {
    throw new HandoffRenderError(
      "Stored handoff and pinned template stage metadata disagree",
    );
  }
  const renderer = environment();
  let first: string;
  let second: string;
  try {
    const context = { handoff, task: input.task };
    first = renderer.renderString(input.template.body, context);
    second = renderer.renderString(input.template.body, context);
  } catch (error) {
    throw new HandoffRenderError(
      `Handoff template render failed: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  if (first !== second) {
    throw new HandoffRenderError(
      "Handoff template render is not deterministic",
    );
  }
  if (first.includes(input.correlationToken)) {
    throw new HandoffRenderError(
      "Handoff template body contains the correlation token",
    );
  }
  return `${identityFrontMatter(input)}${first}`;
};
