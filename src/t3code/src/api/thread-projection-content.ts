/**
 * Projection rules for a thread's content: messages, session and latest
 * turn, checkpoints, activities, and proposed plans. Each function mirrors
 * one branch of the server projector, including its ordering and retention
 * caps. No I/O.
 */
import type { OrchestrationEvent } from "../schemas/orchestration/events.js";
import type {
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadActivity,
} from "../schemas/orchestration/read-model.js";
import {
  checkpointStatusToLatestTurnState,
  settledTurnStateForSessionStatus,
} from "./turn-state.js";

export const MAX_THREAD_MESSAGES = 2_000;
export const MAX_THREAD_CHECKPOINTS = 500;
export const MAX_THREAD_PROPOSED_PLANS = 200;
/** Activities older than this window are dropped unless they must stay reachable. */
export const RECENT_ACTIVITY_WINDOW = 500;
/** Upserted under one id for the thread's whole life; the only durable copy of a running setup. */
export const WORKTREE_SETUP_ACTIVITY_KIND = "worktree-setup";

type MessageSent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>["payload"];
type TurnDiffCompleted = Extract<
  OrchestrationEvent,
  { type: "thread.turn-diff-completed" }
>["payload"];

export function upsertMessage(
  messages: readonly OrchestrationMessage[],
  payload: MessageSent,
): OrchestrationMessage[] {
  const incoming: OrchestrationMessage = {
    id: payload.messageId,
    role: payload.role,
    text: payload.text,
    ...(payload.attachments === undefined ? {} : { attachments: payload.attachments }),
    ...(payload.context === undefined ? {} : { context: payload.context }),
    turnId: payload.turnId,
    streaming: payload.streaming,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
  };
  const existing = messages.find((entry) => entry.id === incoming.id);
  const next = existing
    ? messages.map((entry) =>
        entry.id !== incoming.id
          ? entry
          : {
              ...entry,
              // A streaming delta appends; a final message replaces unless it is empty.
              text: incoming.streaming
                ? `${entry.text}${incoming.text}`
                : incoming.text.length > 0
                  ? incoming.text
                  : entry.text,
              streaming: incoming.streaming,
              updatedAt: incoming.updatedAt,
              turnId: incoming.turnId,
              ...(incoming.attachments === undefined ? {} : { attachments: incoming.attachments }),
              ...(incoming.context === undefined ? {} : { context: incoming.context }),
            },
      )
    : [...messages, incoming];
  return next.slice(-MAX_THREAD_MESSAGES);
}

export function applySessionSet(
  thread: OrchestrationThread,
  session: OrchestrationSession,
  at: string,
): OrchestrationThread {
  const previous = thread.latestTurn;
  let latestTurn = previous;
  if (session.status === "running" && session.activeTurnId !== null) {
    const same = previous?.turnId === session.activeTurnId ? previous : undefined;
    latestTurn = {
      turnId: session.activeTurnId,
      state: "running",
      requestedAt: same?.requestedAt ?? session.updatedAt,
      startedAt: same?.startedAt ?? session.updatedAt,
      completedAt: null,
      assistantMessageId: same?.assistantMessageId ?? null,
    };
  } else if (previous !== null && previous.state === "running") {
    const settled = settledTurnStateForSessionStatus(session.status);
    if (settled !== null) {
      latestTurn = { ...previous, state: settled, completedAt: session.updatedAt };
    }
  }
  return { ...thread, session, latestTurn, updatedAt: at };
}

export function applyTurnDiffCompleted(
  thread: OrchestrationThread,
  payload: TurnDiffCompleted,
  at: string,
): OrchestrationThread {
  const checkpoint = {
    turnId: payload.turnId,
    checkpointTurnCount: payload.checkpointTurnCount,
    checkpointRef: payload.checkpointRef,
    status: payload.status,
    files: payload.files,
    assistantMessageId: payload.assistantMessageId,
    completedAt: payload.completedAt,
  };
  const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
  // A placeholder ("missing") never overwrites a real capture.
  if (existing && existing.status !== "missing" && checkpoint.status === "missing") return thread;
  const checkpoints = [
    ...thread.checkpoints.filter((entry) => entry.turnId !== checkpoint.turnId),
    checkpoint,
  ]
    .sort((a, b) => a.checkpointTurnCount - b.checkpointTurnCount)
    .slice(-MAX_THREAD_CHECKPOINTS);
  const turnStillRunning =
    thread.session?.status === "running" && thread.session.activeTurnId === payload.turnId;
  const previous = thread.latestTurn;
  const same = previous?.turnId === payload.turnId ? previous : undefined;
  const latestTurn: OrchestrationLatestTurn | null = turnStillRunning
    ? previous
    : {
        turnId: payload.turnId,
        state:
          same?.state === "interrupted"
            ? "interrupted"
            : checkpointStatusToLatestTurnState(payload.status),
        requestedAt: same?.requestedAt ?? payload.completedAt,
        startedAt: same?.startedAt ?? payload.completedAt,
        completedAt: payload.completedAt,
        assistantMessageId: payload.assistantMessageId,
      };
  return { ...thread, checkpoints, latestTurn, updatedAt: at };
}

/** Upsert by id, then order and retain the way the server does. */
export function upsertActivity(
  activities: readonly OrchestrationThreadActivity[],
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity[] {
  const next = [...activities.filter((entry) => entry.id !== activity.id), activity].sort(
    compareActivities,
  );
  return retainActivities(next);
}

/** Sequence when both carry one; a sequenced entry sorts after an unsequenced one. */
export function compareActivities(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

/**
 * Keeps the recent window plus what must outlive it: unanswered
 * message-mode questions and the worktree setup record.
 */
export function retainActivities(
  activities: readonly OrchestrationThreadActivity[],
): OrchestrationThreadActivity[] {
  const recentStart = activities.length - RECENT_ACTIVITY_WINDOW;
  if (recentStart <= 0) return [...activities];
  const pending = new Map<string, OrchestrationThreadActivity>();
  for (const activity of activities) {
    const payload = activity.payload;
    if (!payload || typeof payload !== "object") continue;
    const record = payload as Record<string, unknown>;
    const requestId = record["requestId"];
    if (typeof requestId !== "string") continue;
    if (activity.kind === "user-input.requested" && record["responseMode"] === "message") {
      pending.set(requestId, activity);
    } else if (activity.kind === "user-input.resolved") {
      pending.delete(requestId);
    }
  }
  const kept = new Set(pending.values());
  return activities.filter(
    (activity, index) =>
      index >= recentStart || kept.has(activity) || activity.kind === WORKTREE_SETUP_ACTIVITY_KIND,
  );
}

export function upsertProposedPlan(
  proposedPlans: readonly OrchestrationProposedPlan[],
  plan: OrchestrationProposedPlan,
): OrchestrationProposedPlan[] {
  return [...proposedPlans.filter((entry) => entry.id !== plan.id), plan]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .slice(-MAX_THREAD_PROPOSED_PLANS);
}
