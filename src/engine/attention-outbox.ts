// ---
// relationships:
//   implements: heddle
// ---

import { createHash } from "node:crypto";

import type { WorkflowResult } from "flowcraft";

import { awaitingNodeIdsFrom } from "./flowcraft-runtime.js";
import {
  readLifecycleContext,
  writeLifecycleContext,
} from "./lifecycle-state.js";
import type {
  ExpectedLandings,
  LifecycleAttention,
  LifecycleContextRecord,
  LifecyclePersistence,
} from "./types.js";

const attentionEvent = "lifecycle:attention-required";

export const attentionFor = (
  instanceId: string,
  transitionId: string,
  executionId: string | undefined,
  result: WorkflowResult,
  expected: ExpectedLandings,
): LifecycleAttention => {
  const actualAwaitingNodeIds = awaitingNodeIdsFrom(result.serializedContext);
  const attentionId = createHash("sha256")
    .update(
      JSON.stringify([
        instanceId,
        transitionId,
        executionId ?? null,
        result.status,
        actualAwaitingNodeIds,
      ]),
    )
    .digest("hex");
  return {
    actualAwaitingNodeIds,
    actualStatus: result.status,
    attentionId,
    expectedAwaitingNodeIds: [
      ...new Set(expected.flatMap(({ awaitingNodeIds }) => awaitingNodeIds)),
    ].sort(),
    expectedTerminalNodeIds: [
      ...new Set(expected.flatMap(({ terminalNodeIds }) => terminalNodeIds)),
    ].sort(),
    transitionId,
  };
};

export const flushPendingAttentions = (
  persistence: LifecyclePersistence,
  instanceId: string,
) => {
  while (true) {
    const current = persistence.getInstance(instanceId);
    if (current === undefined) {
      throw new Error(`Instance does not exist: ${instanceId}`);
    }
    const context = readLifecycleContext(current);
    const attention = context.pendingAttentions[0];
    if (attention === undefined) return current;
    const wasAppended = persistence
      .replayEvents(instanceId)
      .some(
        ({ payload, type }) =>
          type === attentionEvent &&
          typeof payload === "object" &&
          payload !== null &&
          !Array.isArray(payload) &&
          payload.attentionId === attention.attentionId,
      );
    if (!wasAppended) {
      persistence.appendEvent(instanceId, attentionEvent, attention);
    }
    const nextContext: LifecycleContextRecord = {
      ...context,
      pendingAttentions: context.pendingAttentions.filter(
        ({ attentionId }) => attentionId !== attention.attentionId,
      ),
    };
    persistence.compareAndSwapInstance(
      instanceId,
      current.version,
      writeLifecycleContext(current.state, nextContext),
    );
  }
};
