/**
 * ThreadProjectionTracker: the stateful half of watchThread. It owns the
 * projected thread and turns each applied event into derived items
 * (assistant deltas, request lifecycle, settled turns).
 */
import type { ApprovalRequestId, MessageId, TurnId } from "../schemas/common.js";
import type { UserInputQuestion } from "../schemas/orchestration/activities.js";
import type { OrchestrationEvent } from "../schemas/orchestration/events.js";
import type {
  OrchestrationLatestTurn,
  OrchestrationThread,
  OrchestrationThreadDetailSnapshot,
} from "../schemas/orchestration/read-model.js";
import {
  applyThreadEvent,
  isKnownVariant,
  isSettledTurnState,
  pendingRequests,
  turnOutcome,
  type KnownOrchestrationEvent,
  type PendingRequest,
  type TurnOutcome,
} from "./thread-projection.js";

export type ThreadDerivedItem =
  | {
      readonly kind: "assistant-delta";
      readonly turnId: TurnId | null;
      readonly messageId: MessageId;
      readonly text: string;
    }
  | {
      readonly kind: "approval-requested";
      readonly requestId: ApprovalRequestId;
      readonly activity: PendingRequest["activity"];
      readonly payload: Extract<PendingRequest, { kind: "approval" }>["payload"];
    }
  | {
      readonly kind: "user-input-requested";
      readonly requestId: ApprovalRequestId;
      readonly activity: PendingRequest["activity"];
      readonly questions: UserInputQuestion[];
      readonly payload: Extract<PendingRequest, { kind: "user-input" }>["payload"];
    }
  | { readonly kind: "request-resolved"; readonly requestId: ApprovalRequestId }
  | { readonly kind: "turn-settled"; readonly outcome: TurnOutcome };

export class ThreadProjectionTracker {
  #thread: OrchestrationThread | undefined;
  /** Sequence the projection reflects; events at or below it are not re-applied. */
  #projectedSequence = 0;
  readonly #announced = new Set<ApprovalRequestId>();
  /** Turn ids whose settlement was announced. */
  readonly #settled = new Set<string>();

  get seeded(): boolean {
    return this.#thread !== undefined;
  }

  get thread(): OrchestrationThread | undefined {
    return this.#thread;
  }

  /** Replaces the projection with a snapshot and announces its open requests. */
  *seed(snapshot: OrchestrationThreadDetailSnapshot): Generator<ThreadDerivedItem> {
    this.#thread = snapshot.thread;
    this.#projectedSequence = Math.max(this.#projectedSequence, snapshot.snapshotSequence);
    yield* this.#reconcileRequests();
  }

  /** Applies one event and yields what it changed. */
  *apply(event: OrchestrationEvent): Generator<ThreadDerivedItem> {
    if (!isKnownVariant(event)) return;
    const thread = this.#thread;
    if (!thread) return;
    if (event.sequence <= this.#projectedSequence) {
      yield* this.#replayedEvent(thread, event);
      return;
    }
    const next = applyThreadEvent(thread, event);
    this.#projectedSequence = event.sequence;
    this.#thread = next;
    if (next === thread) return;
    yield* deltaFor(event);
    yield* this.#reconcileRequests();
    yield* this.#settle(thread.latestTurn, next.latestTurn);
    yield* this.#sessionFailure(event, next);
  }

  /**
   * A session error with no running turn (the provider failed before the
   * turn started) settles nothing in the projection, so it is announced as a
   * turn-settled with `turnId: null` for a consumer waiting on that start.
   */
  *#sessionFailure(
    event: KnownOrchestrationEvent,
    thread: OrchestrationThread,
  ): Generator<ThreadDerivedItem> {
    if (event.type !== "thread.session-set") return;
    const session = event.payload.session;
    if (session.status !== "error" || session.activeTurnId !== null) return;
    if (thread.latestTurn?.state === "running") return;
    const key = `session-error:${session.updatedAt}`;
    if (this.#settled.has(key)) return;
    this.#settled.add(key);
    yield { kind: "turn-settled", outcome: turnOutcome(thread, { turnId: null, state: "error" }) };
  }

  /**
   * An event the seed snapshot already reflects. It is not re-applied, but a
   * turn it started or finished may have settled inside the seed; announce that
   * once so a consumer waiting on the turn is not left hanging.
   */
  *#replayedEvent(
    thread: OrchestrationThread,
    event: KnownOrchestrationEvent,
  ): Generator<ThreadDerivedItem> {
    yield* deltaFor(event);
    const turnId =
      event.type === "thread.session-set"
        ? event.payload.session.activeTurnId
        : event.type === "thread.turn-diff-completed"
          ? event.payload.turnId
          : null;
    const latest = thread.latestTurn;
    if (turnId === null || latest?.turnId !== turnId || !isSettledTurnState(latest.state)) return;
    if (this.#settled.has(turnId)) return;
    this.#settled.add(turnId);
    yield { kind: "turn-settled", outcome: turnOutcome(thread, latest) };
  }

  *#settle(
    before: OrchestrationLatestTurn | null,
    after: OrchestrationLatestTurn | null,
  ): Generator<ThreadDerivedItem> {
    if (!after || !isSettledTurnState(after.state)) return;
    const changed = !before || before.turnId !== after.turnId || !isSettledTurnState(before.state);
    if (!changed || this.#settled.has(after.turnId)) return;
    this.#settled.add(after.turnId);
    const thread = this.#thread;
    if (thread) yield { kind: "turn-settled", outcome: turnOutcome(thread, after) };
  }

  *#reconcileRequests(): Generator<ThreadDerivedItem> {
    const thread = this.#thread;
    if (!thread) return;
    const open = pendingRequests(thread);
    const openIds = new Set(open.map((r) => r.requestId));
    for (const requestId of [...this.#announced]) {
      if (openIds.has(requestId)) continue;
      this.#announced.delete(requestId);
      yield { kind: "request-resolved", requestId };
    }
    for (const request of open) {
      if (this.#announced.has(request.requestId)) continue;
      this.#announced.add(request.requestId);
      const { kind: _kind, ...rest } = request;
      yield request.kind === "approval"
        ? { kind: "approval-requested", ...rest, payload: request.payload }
        : {
            kind: "user-input-requested",
            ...rest,
            payload: request.payload,
            questions: request.payload.questions,
          };
    }
  }
}

function* deltaFor(event: KnownOrchestrationEvent): Generator<ThreadDerivedItem> {
  if (event.type !== "thread.message-sent") return;
  const p = event.payload;
  if (p.role !== "assistant" || !p.streaming) return;
  yield { kind: "assistant-delta", turnId: p.turnId, messageId: p.messageId, text: p.text };
}
