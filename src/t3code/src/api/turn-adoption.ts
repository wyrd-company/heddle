/**
 * TurnAdoption: decides which turn a `thread.turn.start` command produced.
 *
 * The server never links a user message to a turn. Its own rule
 * (`threadHasQueuedTurnStart`) is that the message stays queued until a
 * turn's requested, started, or completed stamp reaches the message's
 * `createdAt`; providers steer a message sent during a running turn into
 * that turn. So the turn we follow is the newest one whose stamps reach our
 * command: a turn already running at dispatch takes our message when it
 * settles, a turn that starts after dispatch is ours, and a turn that starts
 * while ours is still running supersedes it (some providers open a new turn
 * without ever completing the steered one). A settled turn older than our
 * command is not ours. No I/O.
 */
import type { MessageId, TurnId } from "../schemas/common.js";
import type { OrchestrationEvent } from "../schemas/orchestration/events.js";
import type {
  OrchestrationLatestTurn,
  OrchestrationThread,
} from "../schemas/orchestration/read-model.js";
import {
  isKnownVariant,
  isSettledTurnState,
  turnOutcome,
  type TurnOutcome,
} from "./thread-projection.js";

export class TurnAdoption {
  readonly #messageId: MessageId;
  readonly #createdAt: string;
  #turnId: TurnId | undefined;
  /** Set once the server links our message to a turn; nothing overrides that. */
  #linked = false;

  constructor(messageId: MessageId, createdAt: string) {
    this.#messageId = messageId;
    this.#createdAt = createdAt;
  }

  /** The turn being followed, once known. */
  get turnId(): TurnId | undefined {
    return this.#turnId;
  }

  /** A snapshot may show a turn running (ours, or about to take our message) or ours already settled. */
  seed(thread: OrchestrationThread): TurnOutcome | undefined {
    const message = thread.messages.find((m) => m.id === this.#messageId);
    if (message?.turnId) this.#link(message.turnId);
    const session = thread.session;
    if (session?.status === "running" && session.activeTurnId !== null) {
      this.#follow(session.activeTurnId);
    }
    const latest = thread.latestTurn;
    if (!latest) return undefined;
    if (latest.state === "running") {
      this.#follow(latest.turnId);
      return undefined;
    }
    if (!isSettledTurnState(latest.state)) return undefined;
    if (latest.turnId !== this.#turnId && !this.#reachesUs(latest)) return undefined;
    this.#follow(latest.turnId);
    return turnOutcome(thread, latest);
  }

  onEvent(event: OrchestrationEvent): void {
    if (!isKnownVariant(event)) return;
    if (event.type === "thread.message-sent") {
      const p = event.payload;
      if (p.messageId === this.#messageId && p.turnId !== null) this.#link(p.turnId);
      return;
    }
    if (event.type !== "thread.session-set") return;
    const session = event.payload.session;
    // A turn starting after our receipt is ours, or supersedes the one we follow.
    if (session.status === "running" && session.activeTurnId !== null) {
      this.#follow(session.activeTurnId);
    }
  }

  /** `true` when a settled turn announced by the projection is ours. */
  onSettled(outcome: TurnOutcome): boolean {
    // A session error with no turn: the start failed before any turn ran.
    if (outcome.turnId === null) return this.#turnId === undefined;
    return outcome.turnId === this.#turnId;
  }

  #follow(turnId: TurnId): void {
    if (!this.#linked) this.#turnId = turnId;
  }

  #link(turnId: TurnId): void {
    this.#turnId = turnId;
    this.#linked = true;
  }

  /** The server's rule: some stamp of the turn is at or after our command's `createdAt`. */
  #reachesUs(turn: OrchestrationLatestTurn): boolean {
    return [turn.requestedAt, turn.startedAt, turn.completedAt].some(
      (stamp) => stamp !== null && stamp >= this.#createdAt,
    );
  }
}
