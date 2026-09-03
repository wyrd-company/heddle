// ---
// relationships:
//   implements: heddle
// ---

import { parseDocument } from "yaml";

import type { JsonValue } from "../persistence/index.js";
import { assertConsoleTokenAbsent } from "./token-disclosure.js";
import type { ConsoleEvent } from "./types.js";

const activationType = "session:activated";
const activationFormat = "heddle.session-activation";
const handoffFormat = "heddle.stage-handoff";
const instanceStateEventTypes = new Set([
  "instance:created",
  "instance:updated",
]);
const frontMatterStart = "---\n";
const frontMatterEnd = "\n---\n";

type SessionActivationIdentity = {
  instanceId: string;
  renderedDocument: string;
  sessionKey: string;
  stage: string;
  systemPrompt: string;
  taskId: number;
  threadId: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const unavailableActivation = (): JsonValue => ({
  format: activationFormat,
  redaction: "session-activation-payload-unavailable",
  version: 1,
});

const sessionActivationIdentity = (
  payload: JsonValue,
): SessionActivationIdentity | undefined => {
  if (
    !isRecord(payload) ||
    payload["format"] !== activationFormat ||
    payload["version"] !== 1 ||
    typeof payload["instanceId"] !== "string" ||
    typeof payload["renderedDocument"] !== "string" ||
    typeof payload["sessionKey"] !== "string" ||
    typeof payload["stage"] !== "string" ||
    typeof payload["systemPrompt"] !== "string" ||
    !Number.isSafeInteger(payload["taskId"]) ||
    typeof payload["threadId"] !== "string"
  ) {
    return undefined;
  }
  return payload as SessionActivationIdentity;
};

const parsedIdentityFrontMatter = (
  serialized: string,
): Record<string, unknown> | undefined => {
  const document = parseDocument(serialized, {
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    return undefined;
  }
  const value = document.toJS() as unknown;
  return isRecord(value) ? value : undefined;
};

const publicRenderedDocument = (
  activation: SessionActivationIdentity,
): string | undefined => {
  const promptPrefix = `${activation.systemPrompt}\n\n`;
  if (!activation.renderedDocument.startsWith(promptPrefix)) return undefined;
  const handoff = activation.renderedDocument.slice(promptPrefix.length);
  if (!handoff.startsWith(frontMatterStart)) return undefined;
  const end = handoff.indexOf(frontMatterEnd, frontMatterStart.length);
  if (end === -1) return undefined;
  const frontMatter = parsedIdentityFrontMatter(
    handoff.slice(frontMatterStart.length, end),
  );
  if (
    frontMatter === undefined ||
    Object.keys(frontMatter).length !== 6 ||
    frontMatter["format"] !== handoffFormat ||
    frontMatter["version"] !== 1 ||
    frontMatter["instanceId"] !== activation.instanceId ||
    frontMatter["sessionKey"] !== activation.sessionKey ||
    frontMatter["taskId"] !== activation.taskId ||
    frontMatter["stage"] !== activation.stage
  ) {
    return undefined;
  }
  const body = handoff.slice(end + frontMatterEnd.length);
  return `${promptPrefix}${[
    "---",
    `format: ${JSON.stringify(handoffFormat)}`,
    "version: 1",
    `instanceId: ${JSON.stringify(activation.instanceId)}`,
    `sessionKey: ${JSON.stringify(activation.sessionKey)}`,
    `taskId: ${activation.taskId}`,
    `stage: ${JSON.stringify(activation.stage)}`,
    "---",
    "",
  ].join("\n")}${body}`;
};

const projectSessionActivation = (payload: JsonValue): JsonValue => {
  const activation = sessionActivationIdentity(payload);
  if (activation === undefined) return unavailableActivation();
  const renderedDocument = publicRenderedDocument(activation);
  if (renderedDocument === undefined) return unavailableActivation();
  return {
    format: activationFormat,
    instanceId: activation.instanceId,
    renderedDocument,
    sessionKey: activation.sessionKey,
    stage: activation.stage,
    systemPrompt: activation.systemPrompt,
    taskId: activation.taskId,
    threadId: activation.threadId,
    version: 1,
  };
};

export const projectPublicConsoleEvent = (
  event: ConsoleEvent,
  correlationTokens: readonly string[],
): ConsoleEvent => {
  const projected = instanceStateEventTypes.has(event.type)
    ? {
        ...event,
        payload: { redaction: "instance-state-payload-unavailable" },
      }
    : event.type === activationType
      ? { ...event, payload: projectSessionActivation(event.payload) }
      : event;
  assertConsoleTokenAbsent(projected, correlationTokens);
  return projected;
};
