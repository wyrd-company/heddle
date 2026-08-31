// ---
// relationships:
//   implements: heddle
// ---

import { parseDocument } from "yaml";

import type { JsonValue } from "../persistence/index.js";
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

const unavailableActivation = (): JsonValue => ({
  format: activationFormat,
  redaction: "session-activation-payload-unavailable",
  version: 1,
});

const sessionActivationIdentity = (
  payload: JsonValue,
): SessionActivationIdentity | undefined => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
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
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
};

const redactRenderedDocument = (
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
    Object.keys(frontMatter).length !== 7 ||
    frontMatter["format"] !== handoffFormat ||
    frontMatter["version"] !== 1 ||
    frontMatter["instanceId"] !== activation.instanceId ||
    frontMatter["sessionKey"] !== activation.sessionKey ||
    frontMatter["taskId"] !== activation.taskId ||
    frontMatter["stage"] !== activation.stage ||
    typeof frontMatter["correlationToken"] !== "string" ||
    frontMatter["correlationToken"].trim() === "" ||
    /\s/.test(frontMatter["correlationToken"])
  ) {
    return undefined;
  }
  const token = frontMatter["correlationToken"];
  if (
    activation.renderedDocument.split(token).length !== 2 ||
    activation.systemPrompt.includes(token) ||
    activation.threadId.includes(token)
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
  const renderedDocument = redactRenderedDocument(activation);
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

export const projectPublicConsoleEvent = (event: ConsoleEvent): ConsoleEvent =>
  instanceStateEventTypes.has(event.type)
    ? {
        ...event,
        payload: { redaction: "instance-state-payload-unavailable" },
      }
    : event.type === activationType
      ? { ...event, payload: projectSessionActivation(event.payload) }
      : event;
