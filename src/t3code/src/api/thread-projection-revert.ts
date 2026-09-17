/**
 * `thread.reverted`: the thread is cut back to a checkpoint. Mirrors the
 * server projector's revert branch: checkpoints past the turn count go,
 * everything tied to a dropped turn goes, and the latest turn is rebuilt from
 * the newest surviving checkpoint. No I/O.
 */
import type {
  OrchestrationMessage,
  OrchestrationThread,
} from "../schemas/orchestration/read-model.js";
import {
  MAX_THREAD_CHECKPOINTS,
  MAX_THREAD_MESSAGES,
  MAX_THREAD_PROPOSED_PLANS,
} from "./thread-projection-content.js";
import { checkpointStatusToLatestTurnState } from "./turn-state.js";

/** Imported agent-session messages are history, not turn output; a revert keeps them. */
export function isImportedAgentSessionMessageId(messageId: string): boolean {
  return messageId.startsWith("import:");
}

export function applyReverted(
  thread: OrchestrationThread,
  turnCount: number,
  at: string,
): OrchestrationThread {
  const checkpoints = thread.checkpoints
    .filter((entry) => entry.checkpointTurnCount <= turnCount)
    .sort((a, b) => a.checkpointTurnCount - b.checkpointTurnCount)
    .slice(-MAX_THREAD_CHECKPOINTS);
  const retainedTurnIds = new Set<string>(checkpoints.map((checkpoint) => checkpoint.turnId));
  const keepsTurn = (turnId: string | null) => turnId === null || retainedTurnIds.has(turnId);
  const messages = retainMessagesAfterRevert(thread.messages, retainedTurnIds, turnCount).slice(
    -MAX_THREAD_MESSAGES,
  );
  const proposedPlans = thread.proposedPlans
    .filter((plan) => keepsTurn(plan.turnId))
    .slice(-MAX_THREAD_PROPOSED_PLANS);
  const activities = thread.activities.filter((activity) => keepsTurn(activity.turnId));
  const latestCheckpoint = checkpoints.at(-1);
  const latestTurn =
    latestCheckpoint === undefined
      ? null
      : {
          turnId: latestCheckpoint.turnId,
          state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
          requestedAt: latestCheckpoint.completedAt,
          startedAt: latestCheckpoint.completedAt,
          completedAt: latestCheckpoint.completedAt,
          assistantMessageId: latestCheckpoint.assistantMessageId,
        };
  return { ...thread, checkpoints, messages, proposedPlans, activities, latestTurn, updatedAt: at };
}

/**
 * System and imported messages always survive; messages of retained turns
 * survive; then unlinked messages fill in, oldest first, until each role has
 * one message per retained turn.
 */
function retainMessagesAfterRevert(
  messages: readonly OrchestrationMessage[],
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): OrchestrationMessage[] {
  const retained = new Set<string>();
  for (const message of messages) {
    if (message.role === "system" || isImportedAgentSessionMessageId(message.id)) {
      retained.add(message.id);
    } else if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retained.add(message.id);
    }
  }
  for (const role of ["user", "assistant"] as const) {
    const count = messages.filter(
      (m) => m.role === role && !isImportedAgentSessionMessageId(m.id) && retained.has(m.id),
    ).length;
    const missing = Math.max(0, turnCount - count);
    if (missing === 0) continue;
    const fallback = messages
      .filter(
        (m) =>
          m.role === role &&
          !retained.has(m.id) &&
          (m.turnId === null || retainedTurnIds.has(m.turnId)),
      )
      .sort((a, b) => compareDateTimeStrings(a.createdAt, b.createdAt) || a.id.localeCompare(b.id))
      .slice(0, missing);
    for (const message of fallback) retained.add(message.id);
  }
  return messages.filter((message) => retained.has(message.id));
}

/** By absolute time; a malformed stamp sorts before a valid one, then lexically. */
function compareDateTimeStrings(left: string, right: string): number {
  const l = Date.parse(left);
  const r = Date.parse(right);
  const lValid = !Number.isNaN(l);
  const rValid = !Number.isNaN(r);
  if (lValid !== rValid) return lValid ? 1 : -1;
  if (lValid) return l - r;
  return left < right ? -1 : left > right ? 1 : 0;
}
