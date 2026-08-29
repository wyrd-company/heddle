// ---
// relationships:
//   implements: heddle
// ---

import { createHash } from "node:crypto";

import type { JsonValue } from "../persistence/index.js";
import {
  objectPayload,
  sessionObservationEventTypes,
} from "./session-observation-events.js";
import type {
  SessionObservationAttention,
  SessionObservationOptions,
  SessionObservationTarget,
} from "./session-observation-types.js";
import type { T3ThreadSnapshot } from "./t3-control-plane-client.js";

export type RequestAttentionKind = "approval" | "user-input";

export const observationHash = (...parts: JsonValue[]): string =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

export const requestIdFor = (
  snapshot: T3ThreadSnapshot,
  kind: "approval.requested" | "user-input.requested",
): string | undefined =>
  snapshot.thread.activities
    ?.filter((activity) => activity.kind === kind)
    .at(-1)?.payload?.requestId;

export const ensureObservationAttention = async (
  options: SessionObservationOptions,
  attention: SessionObservationAttention,
): Promise<SessionObservationAttention> => {
  const recorded = options.persistence
    .replayEvents(attention.instanceId)
    .some(
      (event) =>
        event.type === sessionObservationEventTypes.attentionRequired &&
        objectPayload(event)["attentionId"] === attention.attentionId,
    );
  if (!recorded) {
    options.persistence.appendEvent(
      attention.instanceId,
      sessionObservationEventTypes.attentionRequired,
      attention,
    );
  }
  if (!(await options.attention.has(attention.attentionId))) {
    await options.attention.raise(attention);
  }
  return attention;
};

export const requestAttention = async (
  options: SessionObservationOptions,
  target: SessionObservationTarget,
  snapshot: T3ThreadSnapshot,
  kind: RequestAttentionKind,
): Promise<SessionObservationAttention> => {
  const activityKind =
    kind === "approval" ? "approval.requested" : "user-input.requested";
  const requestId = requestIdFor(snapshot, activityKind);
  if (requestId === undefined) {
    throw new Error(`T3 reports pending ${kind} without a request ID`);
  }
  return ensureObservationAttention(options, {
    attentionId: observationHash(
      target.instanceId,
      target.sessionKey,
      kind,
      requestId,
    ),
    instanceId: target.instanceId,
    kind,
    message: `Session ${target.sessionKey} has pending ${kind}`,
    requestId,
    sessionKey: target.sessionKey,
    threadId: target.threadId,
  });
};
