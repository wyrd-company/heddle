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

const measuredFallbackDrivers = ["claudeAgent", "codex", "cursor"] as const;

export type HandoffAuthenticationBinding = {
  driver: (typeof measuredFallbackDrivers)[number];
  format: "heddle.handoff-authentication-binding";
  policy: "correlation-token-front-matter-v1";
  version: 1;
};

export const isHandoffAuthenticationBinding = (
  value: JsonValue | undefined,
): value is HandoffAuthenticationBinding =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === 4 &&
  measuredFallbackDrivers.some((driver) => value["driver"] === driver) &&
  value["format"] === "heddle.handoff-authentication-binding" &&
  value["policy"] === "correlation-token-front-matter-v1" &&
  value["version"] === 1;

export const resolveHandoffAuthenticationBinding = (
  driver: string,
): HandoffAuthenticationBinding => {
  if (
    !measuredFallbackDrivers.some((measuredDriver) => measuredDriver === driver)
  ) {
    throw new HandoffRenderError(
      `Driver '${driver}' has no measured Heddle MCP authentication policy`,
    );
  }
  return {
    driver: driver as HandoffAuthenticationBinding["driver"],
    format: "heddle.handoff-authentication-binding",
    policy: "correlation-token-front-matter-v1",
    version: 1,
  };
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
    `correlationToken: ${JSON.stringify(input.correlationToken)}`,
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
