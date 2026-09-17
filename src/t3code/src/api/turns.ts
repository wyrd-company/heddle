/**
 * startTurn and TurnHandle: dispatch `thread.turn.start`, then follow the
 * thread from the dispatch receipt until the turn that started for our
 * message settles. `events()` and `completion` share one background watch
 * that starts lazily when `completion` is first read or `events()` is first
 * iterated. Which turn is ours is decided by `TurnAdoption`.
 */
import { T3ConnectionError, T3Error, T3InterruptedError } from "../errors.js";
import { createChannel, type Channel } from "../internal/async-iterable.js";
import type { CommandId, MessageId, ThreadId } from "../schemas/common.js";
import type {
  ClientThreadTurnStartCommand,
  ThreadTurnStartBootstrap,
} from "../schemas/orchestration/commands/turn.js";
import type { ClientOrchestrationCommand } from "../schemas/orchestration/commands.js";
import type { ModelSelection } from "../schemas/orchestration/model.js";
import type { DispatchResult } from "../schemas/orchestration/stream.js";
import type { TurnOutcome } from "./thread-projection.js";
import type { ThreadWatchItem, ThreadWatchOptions } from "./thread-watch.js";
import { TurnAdoption } from "./turn-adoption.js";

export type { TurnOutcome } from "./thread-projection.js";

type TurnStartMessage = ClientThreadTurnStartCommand["message"];

export interface StartTurnInput {
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments?: TurnStartMessage["attachments"];
  readonly context?: TurnStartMessage["context"];
  readonly modelSelection?: ModelSelection;
  /** Defaults to the thread's current mode. */
  readonly runtimeMode?: ClientThreadTurnStartCommand["runtimeMode"];
  /** Defaults to the thread's current mode. */
  readonly interactionMode?: ClientThreadTurnStartCommand["interactionMode"];
  readonly titleSeed?: string;
  readonly bootstrap?: ThreadTurnStartBootstrap;
  readonly signal?: AbortSignal;
}

export interface TurnHandle {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly commandId: CommandId;
  /** The dispatch receipt: the sequence of the turn-start-requested event. */
  readonly sequence: number;
  /**
   * Items from the dispatch receipt until this turn settles. Nothing is
   * buffered until the iterable is iterated; each iteration sees the items
   * that arrive from that point on.
   */
  events(): AsyncIterable<ThreadWatchItem>;
  /** Resolves when the turn that started for `messageId` reaches a terminal state. */
  readonly completion: Promise<TurnOutcome>;
  interrupt(): Promise<void>;
}

export interface TurnDependencies {
  dispatch(command: ClientOrchestrationCommand, signal?: AbortSignal): Promise<DispatchResult>;
  watch(threadId: ThreadId, options: ThreadWatchOptions): AsyncIterable<ThreadWatchItem>;
  newCommandId(): CommandId;
  now(): string;
}

export interface TurnIdentity {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly commandId: CommandId;
  readonly createdAt: string;
  readonly sequence: number;
  readonly signal?: AbortSignal;
}

export function createTurnHandle(deps: TurnDependencies, identity: TurnIdentity): TurnHandle {
  return new Turn(deps, identity);
}

/** Test seam: how many `events()` consumers are attached and how many items they have buffered. */
export function inspectTurn(handle: TurnHandle): { subscribers: number; buffered: number } {
  if (!(handle instanceof Turn)) return { subscribers: 0, buffered: 0 };
  return handle.inspect();
}

class Turn implements TurnHandle {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly commandId: CommandId;
  readonly sequence: number;
  readonly #deps: TurnDependencies;
  readonly #signal: AbortSignal | undefined;
  readonly #controller = new AbortController();
  readonly #subscribers = new Set<Channel<ThreadWatchItem>>();
  readonly #adoption: TurnAdoption;
  #outcome: Promise<TurnOutcome> | undefined;
  #resolve: ((outcome: TurnOutcome) => void) | undefined;
  #reject: ((error: T3Error) => void) | undefined;
  #done = false;

  constructor(deps: TurnDependencies, identity: TurnIdentity) {
    this.#deps = deps;
    this.threadId = identity.threadId;
    this.messageId = identity.messageId;
    this.commandId = identity.commandId;
    this.sequence = identity.sequence;
    this.#signal = identity.signal;
    this.#adoption = new TurnAdoption(identity.messageId, identity.createdAt);
  }

  get completion(): Promise<TurnOutcome> {
    return this.#start();
  }

  events(): AsyncIterable<ThreadWatchItem> {
    return { [Symbol.asyncIterator]: () => this.#subscribe()[Symbol.asyncIterator]() };
  }

  inspect(): { subscribers: number; buffered: number } {
    let buffered = 0;
    for (const channel of this.#subscribers) buffered += channel.size;
    return { subscribers: this.#subscribers.size, buffered };
  }

  async interrupt(): Promise<void> {
    const turnId = this.#adoption.turnId;
    await this.#deps.dispatch({
      type: "thread.turn.interrupt",
      commandId: this.#deps.newCommandId(),
      threadId: this.threadId,
      ...(turnId === undefined ? {} : { turnId }),
      createdAt: this.#deps.now(),
    });
  }

  /** Registers a consumer channel and starts the watch if it is not running yet. */
  #subscribe(): Channel<ThreadWatchItem> {
    const channel = createChannel<ThreadWatchItem>({
      onReturn: () => this.#subscribers.delete(channel),
    });
    if (this.#done) {
      channel.end();
      return channel;
    }
    this.#subscribers.add(channel);
    void this.#start();
    return channel;
  }

  #start(): Promise<TurnOutcome> {
    if (this.#outcome) return this.#outcome;
    this.#outcome = new Promise<TurnOutcome>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    // A consumer that only iterates events() must not see an unhandled rejection.
    this.#outcome.catch(() => undefined);
    this.#signal?.addEventListener("abort", () => this.#controller.abort(), { once: true });
    if (this.#signal?.aborted) this.#controller.abort();
    void this.#run();
    return this.#outcome;
  }

  async #run(): Promise<void> {
    try {
      // `afterSequence` is exclusive on the server (it replays events with a
      // greater sequence). The receipt is the sequence of our own
      // turn-start-requested event, so resuming after it replays exactly what
      // the turn produced: session-set running, deltas, settlement. Passing
      // `sequence - 1` would also replay the user message we just sent.
      const watch = this.#deps.watch(this.threadId, {
        afterSequence: this.sequence,
        signal: this.#controller.signal,
      });
      for await (const item of watch) {
        for (const channel of this.#subscribers) channel.push(item);
        this.#track(item);
        if (this.#done) break;
      }
      if (!this.#done) {
        this.#fail(new T3InterruptedError("The thread watch ended before the turn settled."));
      }
    } catch (error) {
      this.#fail(
        error instanceof T3Error
          ? error
          : new T3ConnectionError("closed", "The turn watch failed.", { cause: error }),
      );
    } finally {
      this.#controller.abort();
      for (const channel of this.#subscribers) channel.end();
      this.#subscribers.clear();
    }
  }

  #track(item: ThreadWatchItem): void {
    switch (item.kind) {
      case "snapshot": {
        const outcome = this.#adoption.seed(item.snapshot.thread);
        if (outcome) this.#settle(outcome);
        return;
      }
      case "event":
        this.#adoption.onEvent(item.event);
        return;
      case "turn-settled":
        if (this.#adoption.onSettled(item.outcome)) this.#settle(item.outcome);
        return;
      default:
        return;
    }
  }

  #settle(outcome: TurnOutcome): void {
    if (this.#done) return;
    this.#done = true;
    this.#resolve?.(outcome);
  }

  #fail(error: T3Error): void {
    if (this.#done) return;
    this.#done = true;
    this.#reject?.(error);
  }
}
