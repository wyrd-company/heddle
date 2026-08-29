// ---
// relationships:
//   implements: heddle
// ---

import { advanceOperationId } from "../mcp-server/operations.js";
import type { InstanceRecord } from "../persistence/index.js";
import { readLifecycleContext } from "../engine/lifecycle-state.js";
import {
  ensureObservationAttention,
  observationHash,
} from "./session-observation-attention.js";
import {
  eventsForSession,
  objectPayload,
  sessionObservationEventTypes,
} from "./session-observation-events.js";
import type {
  SessionObservationAttention,
  SessionObservationOptions,
  SessionObservationResult,
  SessionObservationTarget,
} from "./session-observation-types.js";

type LivenessKind = "blocked" | "ended" | "failed" | "stalled";

const livenessKindFor = (
  phase: SessionObservationResult["phase"],
): LivenessKind => {
  if (phase === "waiting_for_approval" || phase === "waiting_for_input") {
    return "blocked";
  }
  if (phase === "failed") return "failed";
  if (phase === "completed" || phase === "absent") return "ended";
  return "stalled";
};

const stageFingerprint = (
  record: InstanceRecord,
  sessionKey: string,
): string => {
  const context = readLifecycleContext(record);
  return observationHash(
    context.awaitingNodeIds,
    Object.hasOwn(context.completedOperations, advanceOperationId(sessionKey)),
  );
};

const thresholdFor = (
  options: SessionObservationOptions,
  kind: Exclude<LivenessKind, "blocked">,
): number => {
  if (kind === "ended") return options.thresholds.endedMilliseconds;
  if (kind === "failed") return options.thresholds.failedMilliseconds;
  return options.thresholds.stalledMilliseconds;
};

export const isStageSessionTerminal = (
  record: InstanceRecord,
  sessionKey: string,
): boolean =>
  Object.hasOwn(
    readLifecycleContext(record).completedOperations,
    advanceOperationId(sessionKey),
  );

export const observeSessionLiveness = async (
  options: SessionObservationOptions,
  target: SessionObservationTarget,
  phase: SessionObservationResult["phase"],
  record: InstanceRecord,
  now: () => number,
): Promise<SessionObservationAttention | undefined> => {
  if (isStageSessionTerminal(record, target.sessionKey)) return undefined;
  const kind = livenessKindFor(phase);
  const fingerprint = stageFingerprint(record, target.sessionKey);
  const latest = eventsForSession(
    options.persistence.replayEvents(target.instanceId),
    target.sessionKey,
    target.threadId,
  )
    .filter(({ type }) => type === sessionObservationEventTypes.livenessSampled)
    .at(-1);
  const payload = latest === undefined ? undefined : objectPayload(latest);
  if (
    payload?.["kind"] !== kind ||
    payload["stageFingerprint"] !== fingerprint
  ) {
    options.persistence.appendEvent(
      target.instanceId,
      sessionObservationEventTypes.livenessSampled,
      {
        ...target,
        kind,
        observedAt: now(),
        phase,
        stageFingerprint: fingerprint,
      },
    );
    return undefined;
  }
  if (kind === "blocked") return undefined;
  const startedAt = payload["observedAt"];
  if (typeof startedAt !== "number") {
    throw new Error(
      `Liveness sample ${latest?.sequence} has an invalid timestamp`,
    );
  }
  if (now() - startedAt < thresholdFor(options, kind)) return undefined;
  return ensureObservationAttention(options, {
    attentionId: observationHash(
      target.instanceId,
      target.sessionKey,
      kind,
      startedAt,
      fingerprint,
    ),
    instanceId: target.instanceId,
    kind,
    message: `Session ${target.sessionKey} is ${kind} without lifecycle advance`,
    sessionKey: target.sessionKey,
    threadId: target.threadId,
  });
};
