// ---
// relationships:
//   implements: heddle
// ---

import { posix } from "node:path";

import nunjucks from "nunjucks";

import type { JsonValue } from "../persistence/index.js";
import type {
  PinnedHandoffTemplate,
  PinnedSkill,
} from "./handoff-template-store.js";

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

export type HandoffDriver = string;

export type HandoffAuthenticationBinding = {
  driver: HandoffDriver;
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
  typeof value["driver"] === "string" &&
  value["driver"].trim() !== "" &&
  value["format"] === "heddle.handoff-authentication-binding" &&
  value["policy"] === "external-provider-session-v1" &&
  value["version"] === 1;

export const resolveHandoffAuthenticationBinding = (
  driver: string,
): HandoffAuthenticationBinding => {
  if (driver.trim() === "") {
    throw new HandoffRenderError("T3 driver kind must not be empty");
  }
  return {
    driver,
    format: "heddle.handoff-authentication-binding",
    policy: "external-provider-session-v1",
    version: 1,
  };
};

export const resolveEffectiveHandoffDriver = (
  modelSelectionInstanceId: string,
  providerContextDriver: string,
  providerContextInstanceId: string,
): HandoffDriver => {
  if (modelSelectionInstanceId !== providerContextInstanceId) {
    throw new HandoffRenderError(
      "T3 model selection and provider context must name the same provider instance",
    );
  }
  return resolveHandoffAuthenticationBinding(providerContextDriver).driver;
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

const includeDirectory = "handoff-templates/includes/";

const assertIncludeSpecifier = (name: string): void => {
  if (
    name.includes("\\") ||
    posix.normalize(name) !== name ||
    !name.startsWith(includeDirectory) ||
    name === includeDirectory
  ) {
    throw new HandoffRenderError(
      `Handoff include must use a repository-relative path inside ${includeDirectory}: ${JSON.stringify(name)}`,
    );
  }
};

type NunjucksSyntaxNode = {
  [key: string]: unknown;
  typename?: string;
};

const assertSupportedTemplateSyntax = (body: string, path: string): void => {
  const parser = (
    nunjucks as unknown as {
      parser: { parse(source: string): NunjucksSyntaxNode };
    }
  ).parser;
  const root = parser.parse(body);
  const visited = new Set<object>();
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null || visited.has(value)) {
      return;
    }
    visited.add(value);
    const node = value as NunjucksSyntaxNode;
    if (
      node.typename === "Extends" ||
      node.typename === "Import" ||
      node.typename === "FromImport"
    ) {
      throw new HandoffRenderError(
        `Handoff template ${JSON.stringify(path)} uses unsupported ${node.typename} syntax; only include is supported`,
      );
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(root);
};

class PinnedIncludeLoader extends nunjucks.Loader {
  constructor(private readonly includes: Readonly<Record<string, string>>) {
    super();
  }

  getSource(name: string): nunjucks.LoaderSource {
    assertIncludeSpecifier(name);
    const source = this.includes[name];
    if (source === undefined) {
      throw new HandoffRenderError(
        `Pinned handoff include is unavailable: ${name}`,
      );
    }
    assertSupportedTemplateSyntax(source, name);
    return { noCache: true, path: name, src: source };
  }
}

const environment = (
  includes: Readonly<Record<string, string>>,
  skills: Readonly<Record<string, PinnedSkill>>,
): nunjucks.Environment => {
  const result = new nunjucks.Environment(new PinnedIncludeLoader(includes), {
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
  result.addGlobal("skill", (name: unknown) => {
    if (typeof name !== "string" || !Object.hasOwn(skills, name)) {
      throw new HandoffRenderError(
        `Handoff template requested undeclared pinned skill: ${JSON.stringify(name)}`,
      );
    }
    const resolved = skills[name]!;
    return {
      description: resolved.description,
      name: resolved.name,
      path: resolved.path,
    };
  });
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
  if (
    Object.values(input.template.skills).some(({ source }) =>
      source.includes(input.correlationToken),
    )
  ) {
    throw new HandoffRenderError(
      "Pinned skill source contains the correlation token",
    );
  }
  const renderer = environment(input.template.includes, input.template.skills);
  let first: string;
  let second: string;
  try {
    assertSupportedTemplateSyntax(input.template.body, input.template.path);
    const context = { handoff, task: input.task };
    first = new nunjucks.Template(
      input.template.body,
      renderer,
      input.template.path,
    ).render(context);
    second = new nunjucks.Template(
      input.template.body,
      renderer,
      input.template.path,
    ).render(context);
  } catch (error) {
    if (error instanceof HandoffRenderError) throw error;
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
