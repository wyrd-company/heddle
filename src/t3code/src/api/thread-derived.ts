/**
 * Values derived from a projected thread: open requests, the outcome of a
 * settled turn, and the phase of a shell thread. Pure functions.
 */
import { approvalRequestId, type ApprovalRequestId, type TurnId } from "../schemas/common.js";
import {
  ApprovalRequestedPayload,
  UserInputRequestedPayload,
  openRequests,
} from "../schemas/orchestration/activities.js";
import type {
  OrchestrationLatestTurnState,
  OrchestrationMessage,
  OrchestrationThread,
  OrchestrationThreadActivity,
} from "../schemas/orchestration/read-model.js";
import type { OrchestrationThreadShell } from "../schemas/orchestration/shell.js";
import { isSettledTurnState, type SettledTurnState } from "./turn-state.js";

export type PendingRequest =
  | {
      readonly kind: "approval";
      readonly requestId: ApprovalRequestId;
      readonly activity: OrchestrationThreadActivity;
      readonly payload: ApprovalRequestedPayload;
    }
  | {
      readonly kind: "user-input";
      readonly requestId: ApprovalRequestId;
      readonly activity: OrchestrationThreadActivity;
      readonly payload: UserInputRequestedPayload;
    };

export type ThreadPhase =
  | "waiting_for_approval"
  | "waiting_for_input"
  | "failed"
  | "starting"
  | "running"
  | "completed"
  | "idle";

export interface TurnOutcome {
  readonly state: SettledTurnState;
  readonly turnId: TurnId | null;
  readonly assistantMessage?: OrchestrationMessage;
  readonly error?: string;
  readonly thread: OrchestrationThread;
}

/** Open approval and user-input requests, in activity order (the decider's rule). */
export function pendingRequests(thread: {
  readonly activities: readonly OrchestrationThreadActivity[];
}): PendingRequest[] {
  const out: PendingRequest[] = [];
  for (const [id, activity] of openRequests(thread.activities)) {
    const request = toPendingRequest(id, activity);
    if (request) out.push(request);
  }
  return out;
}

export function toPendingRequest(
  id: string,
  activity: OrchestrationThreadActivity,
): PendingRequest | undefined {
  const requestId = approvalRequestId(id);
  if (activity.kind === "approval.requested") {
    const payload = ApprovalRequestedPayload.safeParse(activity.payload);
    return payload.success
      ? { kind: "approval", requestId, activity, payload: payload.data }
      : undefined;
  }
  if (activity.kind === "user-input.requested") {
    const payload = UserInputRequestedPayload.safeParse(activity.payload);
    return payload.success
      ? { kind: "user-input", requestId, activity, payload: payload.data }
      : undefined;
  }
  return undefined;
}

/** The outcome of a settled turn, read from the projected thread. */
export function turnOutcome(
  thread: OrchestrationThread,
  turn: { readonly turnId: TurnId | null; readonly state: OrchestrationLatestTurnState },
): TurnOutcome {
  const state = isSettledTurnState(turn.state) ? turn.state : "error";
  const assistantMessage = assistantMessageForTurn(thread, turn.turnId);
  const error = state === "error" ? (thread.session?.lastError ?? undefined) : undefined;
  return {
    state,
    turnId: turn.turnId,
    ...(assistantMessage === undefined ? {} : { assistantMessage }),
    ...(error === undefined ? {} : { error }),
    thread,
  };
}

export function assistantMessageForTurn(
  thread: OrchestrationThread,
  turnId: TurnId | null,
): OrchestrationMessage | undefined {
  const byId = thread.latestTurn?.assistantMessageId;
  const linked =
    byId !== null && byId !== undefined && thread.latestTurn?.turnId === turnId
      ? thread.messages.find((m) => m.id === byId)
      : undefined;
  if (linked) return linked;
  if (turnId === null) return undefined;
  return thread.messages.findLast((m) => m.role === "assistant" && m.turnId === turnId);
}

/** Pure classification of a shell thread. */
export function threadPhase(shell: OrchestrationThreadShell): ThreadPhase {
  if (shell.hasPendingApprovals) return "waiting_for_approval";
  if (shell.hasPendingUserInput) return "waiting_for_input";
  const session = shell.session;
  const turn = shell.latestTurn;
  if (session?.status === "error" || turn?.state === "error") return "failed";
  if (session?.status === "starting") return "starting";
  if (session?.status === "running" || turn?.state === "running") return "running";
  if (turn?.state === "completed" || (turn?.state === "interrupted" && turn.completedAt !== null)) {
    return "completed";
  }
  if (session?.status === "ready" || session?.status === "idle") return "completed";
  return "idle";
}
