// ---
// relationships:
//   implements: heddle
// ---

import type { JsonValue, PersistedEvent } from "../persistence/index.js";

export const sessionObservationEventTypes = {
  archiveCompleted: "observation:archive-completed",
  archiveIssued: "observation:archive-issued",
  attentionRequired: "observation:attention-required",
  interruptCompleted: "observation:interrupt-completed",
  interruptIssued: "observation:interrupt-issued",
  livenessSampled: "observation:liveness-sampled",
  questionDispositionCompleted: "observation:question-disposition-completed",
  questionDispositionIssued: "observation:question-disposition-issued",
  sessionStopCompleted: "observation:session-stop-completed",
  sessionStopIssued: "observation:session-stop-issued",
  threadRecorded: "observation:thread-recorded",
} as const;

export const objectPayload = (
  event: PersistedEvent,
): Record<string, JsonValue> => {
  if (
    typeof event.payload !== "object" ||
    event.payload === null ||
    Array.isArray(event.payload)
  ) {
    throw new Error(
      `Observation event ${event.sequence} has an invalid payload`,
    );
  }
  return event.payload;
};

export const eventsForSession = (
  events: PersistedEvent[],
  sessionKey: string,
  threadId: string,
): PersistedEvent[] =>
  events.filter((event) => {
    if (!event.type.startsWith("observation:")) return false;
    const payload = objectPayload(event);
    return (
      payload["sessionKey"] === sessionKey && payload["threadId"] === threadId
    );
  });

export const eventWithOperation = (
  events: PersistedEvent[],
  type: string,
  operationId: string,
): PersistedEvent | undefined =>
  events.find(
    (event) =>
      event.type === type &&
      objectPayload(event)["operationId"] === operationId,
  );
