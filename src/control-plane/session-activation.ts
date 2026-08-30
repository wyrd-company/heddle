// ---
// relationships:
//   implements: heddle
// ---

import type { JsonValue, PersistedEvent } from "../persistence/index.js";

export const sessionActivatedEvent = "session:activated";

export type SessionActivationPayload = {
  format: "heddle.session-activation";
  instanceId: string;
  renderedDocument: string;
  sessionKey: string;
  stage: string;
  taskId: number;
  threadId: string;
  version: 1;
};

export interface SessionActivationEventStore {
  appendEvent(
    instanceId: string,
    type: string,
    payload: JsonValue,
  ): PersistedEvent;
  replayEvents(instanceId: string, afterSequence?: number): PersistedEvent[];
}

const payloadFor = (input: SessionActivationPayload): JsonValue => ({
  format: input.format,
  instanceId: input.instanceId,
  renderedDocument: input.renderedDocument,
  sessionKey: input.sessionKey,
  stage: input.stage,
  taskId: input.taskId,
  threadId: input.threadId,
  version: input.version,
});

export const recordSessionActivation = (
  store: SessionActivationEventStore,
  input: SessionActivationPayload,
): PersistedEvent => {
  const payload = payloadFor(input);
  const existing = store
    .replayEvents(input.instanceId)
    .filter(
      (event) =>
        event.type === sessionActivatedEvent &&
        typeof event.payload === "object" &&
        event.payload !== null &&
        !Array.isArray(event.payload) &&
        event.payload["sessionKey"] === input.sessionKey,
    );
  if (existing.length > 1) {
    throw new Error(
      `Session '${input.sessionKey}' has more than one activation event`,
    );
  }
  if (existing.length === 1) {
    if (JSON.stringify(existing[0]!.payload) !== JSON.stringify(payload)) {
      throw new Error(
        `Session '${input.sessionKey}' activation payload changed during replay`,
      );
    }
    return existing[0]!;
  }
  return store.appendEvent(input.instanceId, sessionActivatedEvent, payload);
};
