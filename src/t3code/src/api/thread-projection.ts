/**
 * Pure event-application rules for one thread, mirroring the server's
 * projector (`apps/server/src/orchestration/projector.ts`) closely enough
 * that a client-side projection seeded from a snapshot and fed the thread's
 * events stays in step with the server's read model. Every event type the
 * server knows has a branch here; unknown variants leave the thread as is.
 * No I/O.
 */
import type { OrchestrationEvent } from "../schemas/orchestration/events.js";
import type { OrchestrationThread } from "../schemas/orchestration/read-model.js";
import {
  applySessionSet,
  applyTurnDiffCompleted,
  upsertActivity,
  upsertMessage,
  upsertProposedPlan,
} from "./thread-projection-content.js";
import {
  applyPullRequestLinked,
  applyPullRequestSynced,
  applyPullRequestUnlinked,
} from "./thread-projection-links.js";
import { applyReverted } from "./thread-projection-revert.js";

export {
  assistantMessageForTurn,
  pendingRequests,
  threadPhase,
  toPendingRequest,
  turnOutcome,
  type PendingRequest,
  type ThreadPhase,
  type TurnOutcome,
} from "./thread-derived.js";
export {
  isSettledTurnState,
  settledTurnStateForSessionStatus,
  type SettledTurnState,
} from "./turn-state.js";

/** Narrows a growing tagged union to its recognised members. */
export function isKnownVariant<T extends object>(value: T): value is Exclude<T, { unknown: true }> {
  return (value as { unknown?: unknown }).unknown !== true;
}

export type KnownOrchestrationEvent = Exclude<OrchestrationEvent, { unknown: true }>;

/** Applies one event to the thread. Events for other threads and unknown events leave it unchanged. */
export function applyThreadEvent(
  thread: OrchestrationThread,
  event: OrchestrationEvent,
): OrchestrationThread {
  if (!isKnownVariant(event)) return thread;
  if (event.aggregateKind !== "thread" || event.aggregateId !== thread.id) return thread;
  const at = event.occurredAt;
  switch (event.type) {
    case "thread.message-sent":
      return { ...thread, messages: upsertMessage(thread.messages, event.payload), updatedAt: at };
    case "thread.session-set":
      return applySessionSet(thread, event.payload.session, at);
    case "thread.turn-diff-completed":
      return applyTurnDiffCompleted(thread, event.payload, at);
    case "thread.activity-appended":
      return {
        ...thread,
        activities: upsertActivity(thread.activities, event.payload.activity),
        updatedAt: at,
      };
    case "thread.proposed-plan-upserted":
      return {
        ...thread,
        proposedPlans: upsertProposedPlan(thread.proposedPlans, event.payload.proposedPlan),
        updatedAt: at,
      };
    case "thread.reverted":
      return applyReverted(thread, event.payload.turnCount, at);
    case "thread.meta-updated":
      return applyMetaUpdated(thread, event.payload);
    case "thread.pull-request-linked":
      return applyPullRequestLinked(thread, event.payload.link, event.payload.updatedAt);
    case "thread.pull-request-unlinked":
      return applyPullRequestUnlinked(thread, event.payload, event.payload.updatedAt);
    case "thread.pull-request-synced":
      return applyPullRequestSynced(thread, event.payload);
    case "thread.runtime-mode-set":
      return {
        ...thread,
        runtimeMode: event.payload.runtimeMode,
        updatedAt: event.payload.updatedAt,
      };
    case "thread.interaction-mode-set":
      return {
        ...thread,
        interactionMode: event.payload.interactionMode,
        updatedAt: event.payload.updatedAt,
      };
    case "thread.archived":
      return {
        ...thread,
        archivedAt: event.payload.archivedAt,
        titleRegeneration: null,
        updatedAt: event.payload.updatedAt,
      };
    case "thread.unarchived":
      return { ...thread, archivedAt: null, updatedAt: event.payload.updatedAt };
    case "thread.settled":
      return {
        ...thread,
        settledOverride: "settled",
        settledAt: event.payload.settledAt,
        unsettledAt: null,
        activeOrderKey: null,
        updatedAt: event.payload.updatedAt,
      };
    case "thread.unsettled":
      return {
        ...thread,
        settledOverride: event.payload.reason === "user" ? "active" : null,
        settledAt: null,
        // A thread already pinned active keeps its re-entry stamp.
        unsettledAt:
          thread.settledOverride === "active"
            ? (thread.unsettledAt ?? null)
            : event.payload.updatedAt,
        updatedAt: event.payload.updatedAt,
      };
    case "thread.snoozed":
      return {
        ...thread,
        snoozedUntil: event.payload.snoozedUntil,
        snoozedAt: event.payload.snoozedAt,
        updatedAt: event.payload.updatedAt,
      };
    case "thread.unsnoozed":
      return { ...thread, snoozedUntil: null, snoozedAt: null, updatedAt: event.payload.updatedAt };
    case "thread.pinned":
      return {
        ...thread,
        pinnedAt: event.payload.pinnedAt,
        ...(event.payload.pinOrderKey === undefined
          ? {}
          : { pinOrderKey: event.payload.pinOrderKey }),
        updatedAt: event.payload.updatedAt,
      };
    case "thread.unpinned":
      // Unpinning clears the slot: pinning again is "pin again", not "restore the old position".
      return { ...thread, pinnedAt: null, pinOrderKey: null, updatedAt: event.payload.updatedAt };
    case "thread.pin-reordered":
      return { ...thread, pinOrderKey: event.payload.orderKey, updatedAt: event.payload.updatedAt };
    case "thread.deleted":
      return { ...thread, deletedAt: event.payload.deletedAt, updatedAt: event.payload.deletedAt };
    // Intents and creation: the projector records nothing for an existing thread.
    case "thread.created":
    case "thread.turn-start-requested":
    case "thread.turn-interrupt-requested":
    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
    case "thread.checkpoint-revert-requested":
    case "thread.session-stop-requested":
    case "project.created":
    case "project.meta-updated":
    case "project.deleted":
      return thread;
    default:
      return unreachableEvent(event, thread);
  }
}

/** Compile-time check that every known event type has a branch above. */
function unreachableEvent(event: never, thread: OrchestrationThread): OrchestrationThread {
  void event;
  return thread;
}

type MetaUpdated = Extract<OrchestrationEvent, { type: "thread.meta-updated" }>["payload"];

function applyMetaUpdated(thread: OrchestrationThread, p: MetaUpdated): OrchestrationThread {
  return {
    ...thread,
    ...(p.title === undefined ? {} : { title: p.title }),
    ...(p.modelSelection === undefined ? {} : { modelSelection: p.modelSelection }),
    ...(p.branch === undefined ? {} : { branch: p.branch }),
    ...(p.worktreePath === undefined ? {} : { worktreePath: p.worktreePath }),
    ...(p.linkedPullRequest === undefined ? {} : { linkedPullRequest: p.linkedPullRequest }),
    ...(p.branchPullRequest === undefined ? {} : { branchPullRequest: p.branchPullRequest }),
    ...(p.titleRegeneration === undefined ? {} : { titleRegeneration: p.titleRegeneration }),
    ...(p.titleState === undefined ? {} : { titleState: p.titleState }),
    ...(p.activeOrderKey === undefined ? {} : { activeOrderKey: p.activeOrderKey }),
    updatedAt: p.updatedAt,
  };
}
