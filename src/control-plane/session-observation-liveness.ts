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

type AttentionLivenessKind = Exclude<LivenessKind, "blocked">;

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
  kind: AttentionLivenessKind,
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

const livenessAttentionIdsFor = (
  options: SessionObservationOptions,
  target: SessionObservationTarget,
): string[] => {
  const events = eventsForSession(
    options.persistence.replayEvents(target.instanceId),
    target.sessionKey,
    target.threadId,
  );
  const attentionIds = new Set<string>();
  let latestSample: (typeof events)[number] | undefined;
  for (const event of events) {
    if (event.type === sessionObservationEventTypes.livenessSampled) {
      latestSample = event;
      continue;
    }
    if (event.type !== sessionObservationEventTypes.attentionRequired) continue;
    const payload = objectPayload(event);
    const kind = payload["kind"];
    if (kind === "approval" || kind === "user-input") continue;
    if (kind !== "ended" && kind !== "failed" && kind !== "stalled") {
      throw new Error(
        `Observation attention event ${event.sequence} has an invalid kind`,
      );
    }
    if (payload["instanceId"] !== target.instanceId) {
      throw new Error(
        `Observation attention event ${event.sequence} disagrees with its instance`,
      );
    }
    const attentionId = payload["attentionId"];
    if (typeof attentionId !== "string" || attentionId.trim() === "") {
      throw new Error(
        `Observation attention event ${event.sequence} has no attention identity`,
      );
    }
    if (latestSample === undefined) {
      throw new Error(
        `Observation attention event ${event.sequence} has no matching liveness sample`,
      );
    }
    const samplePayload = objectPayload(latestSample);
    const observedAt = samplePayload["observedAt"];
    const stageFingerprint = samplePayload["stageFingerprint"];
    if (
      samplePayload["instanceId"] !== target.instanceId ||
      samplePayload["kind"] !== kind ||
      typeof observedAt !== "number" ||
      !Number.isFinite(observedAt) ||
      typeof stageFingerprint !== "string" ||
      stageFingerprint.trim() === ""
    ) {
      throw new Error(
        `Observation attention event ${event.sequence} has no matching liveness sample`,
      );
    }
    const expectedId = observationHash(
      target.instanceId,
      target.sessionKey,
      kind,
      observedAt,
      stageFingerprint,
    );
    if (attentionId !== expectedId) {
      throw new Error(
        `Observation attention event ${event.sequence} disagrees with its liveness sample`,
      );
    }
    attentionIds.add(attentionId);
  }
  return [...attentionIds];
};

const resolveCompletedSessionLiveness = async (
  options: SessionObservationOptions,
  target: SessionObservationTarget,
): Promise<void> => {
  const attentionIds = livenessAttentionIdsFor(options, target);
  for (const attentionId of attentionIds) {
    if (await options.attention.has(attentionId)) {
      await options.attention.resolve(attentionId);
    }
  }
};

export const observeSessionLiveness = async (
  options: SessionObservationOptions,
  target: SessionObservationTarget,
  phase: SessionObservationResult["phase"],
  record: InstanceRecord,
  now: () => number,
): Promise<SessionObservationAttention | undefined> => {
  if (isStageSessionTerminal(record, target.sessionKey)) {
    await resolveCompletedSessionLiveness(options, target);
    return undefined;
  }
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
