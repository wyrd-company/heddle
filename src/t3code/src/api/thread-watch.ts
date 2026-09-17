/**
 * watchThread: a resumable live view of one thread. It subscribes with
 * `orchestration.subscribeThread`, keeps a projected `OrchestrationThread`
 * (seeded from the snapshot frame, or from `snapshotLoader` when the server
 * replays events instead of sending a snapshot), derives domain items from
 * the projection, and resubscribes with `afterSequence` when the socket drops.
 */
import { T3ConnectionError, T3InterruptedError, type T3DecodeError } from "../errors.js";
import type { RpcClient } from "../rpc/client.js";
import type { RpcMethods } from "../rpc/registry.js";
import type { ThreadId } from "../schemas/common.js";
import type { OrchestrationEvent } from "../schemas/orchestration/events.js";
import type { OrchestrationThreadDetailSnapshot } from "../schemas/orchestration/read-model.js";
import { isKnownVariant } from "./thread-projection.js";
import { ThreadProjectionTracker, type ThreadDerivedItem } from "./thread-tracker.js";

export type { ThreadDerivedItem } from "./thread-tracker.js";

export type ThreadWatchItem =
  | { readonly kind: "snapshot"; readonly snapshot: OrchestrationThreadDetailSnapshot }
  | { readonly kind: "synchronized" }
  | { readonly kind: "event"; readonly event: OrchestrationEvent }
  | ThreadDerivedItem
  | { readonly kind: "decode-error"; readonly error: T3DecodeError }
  | { readonly kind: "reconnected"; readonly afterSequence: number };

export interface ThreadWatchOptions {
  /** Resume after this sequence instead of asking for a snapshot. */
  readonly afterSequence?: number;
  readonly turnLimit?: number;
  readonly signal?: AbortSignal;
  /** Loads a detail snapshot when the server replays events without one (HTTP thread detail). */
  readonly snapshotLoader?: (signal?: AbortSignal) => Promise<OrchestrationThreadDetailSnapshot>;
}

export type ThreadWatchRpc = Pick<RpcClient<RpcMethods>, "stream">;

export function watchThread(
  rpc: ThreadWatchRpc,
  threadId: ThreadId,
  options: ThreadWatchOptions = {},
): AsyncIterable<ThreadWatchItem> {
  return { [Symbol.asyncIterator]: () => run(rpc, threadId, options) };
}

async function* run(
  rpc: ThreadWatchRpc,
  threadId: ThreadId,
  options: ThreadWatchOptions,
): AsyncGenerator<ThreadWatchItem> {
  const { signal } = options;
  const tracker = new ThreadProjectionTracker();
  // The resume cursor: the last sequence the consumer has seen.
  let afterSequence = options.afterSequence;
  // Subscriptions that fail before delivering anything: two in a row means the
  // transport is closed for good, not merely reconnecting.
  let emptyAttempts = 0;
  let resumed = false;
  for (;;) {
    if (signal?.aborted) return;
    let received = false;
    try {
      const payload = {
        threadId,
        requestCompletionMarker: true,
        ...(afterSequence === undefined ? {} : { afterSequence }),
        ...(options.turnLimit === undefined ? {} : { turnLimit: options.turnLimit }),
      };
      const stream = rpc.stream("orchestration.subscribeThread", payload, {
        ...(signal === undefined ? {} : { signal }),
      });
      for await (const item of stream) {
        if (!received && resumed) {
          yield { kind: "reconnected", afterSequence: afterSequence ?? 0 };
        }
        received = true;
        if (item.kind === "decode-error") {
          yield item;
          continue;
        }
        const value = item.value;
        if (!isKnownVariant(value)) continue;
        if (value.kind === "snapshot") {
          afterSequence = Math.max(afterSequence ?? 0, value.snapshot.snapshotSequence);
          yield value;
          yield* tracker.seed(value.snapshot);
          continue;
        }
        if (!tracker.seeded && options.snapshotLoader) {
          // Resuming: the server replays events after `afterSequence` without a
          // snapshot, so the projection is seeded from a detail snapshot. Replayed
          // events the snapshot already reflects are passed through but not
          // re-applied, so streaming deltas are not appended twice.
          const snapshot = await options.snapshotLoader(signal);
          yield { kind: "snapshot", snapshot };
          yield* tracker.seed(snapshot);
        }
        if (value.kind === "synchronized") {
          yield value;
          continue;
        }
        const event = value.event;
        const sequence = eventSequence(event);
        if (sequence !== undefined) {
          if (afterSequence !== undefined && sequence <= afterSequence) continue; // replay overlap
          afterSequence = sequence;
        }
        yield { kind: "event", event };
        yield* tracker.apply(event);
      }
      return;
    } catch (error) {
      if (signal?.aborted || error instanceof T3InterruptedError) return;
      emptyAttempts = received ? 0 : emptyAttempts + 1;
      if (
        error instanceof T3ConnectionError &&
        error.reason !== "open_failed" &&
        emptyAttempts < 2
      ) {
        // The transport reconnects on its own; we only need to resubscribe.
        resumed = true;
        continue;
      }
      throw error;
    }
  }
}

function eventSequence(event: OrchestrationEvent): number | undefined {
  if (isKnownVariant(event)) return event.sequence;
  const raw = event.raw["sequence"];
  return typeof raw === "number" ? raw : undefined;
}
