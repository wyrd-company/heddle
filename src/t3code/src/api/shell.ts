/**
 * ShellApi: the lightweight cross-thread view (projects and thread shells)
 * as a snapshot over HTTP or a resumable live stream over RPC.
 */
import { T3ConnectionError, T3InterruptedError, type T3DecodeError } from "../errors.js";
import type { RpcClient } from "../rpc/client.js";
import type { RpcMethods } from "../rpc/registry.js";
import {
  OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
} from "../schemas/orchestration/shell.js";
import type { HttpTransport } from "../transport/http.js";
import { isKnownVariant } from "./thread-projection.js";

export type ShellWatchItem =
  | Exclude<OrchestrationShellStreamItem, { unknown: true }>
  | { readonly kind: "decode-error"; readonly error: T3DecodeError }
  | { readonly kind: "reconnected"; readonly afterSequence: number };

export interface ShellWatchOptions {
  readonly afterSequence?: number;
  readonly signal?: AbortSignal;
}

export function loadShellSnapshot(
  http: HttpTransport,
  signal?: AbortSignal,
): Promise<OrchestrationShellSnapshot> {
  return http.request({
    method: "GET",
    path: "/api/orchestration/shell",
    auth: "required",
    decode: OrchestrationShellSnapshot,
    ...(signal === undefined ? {} : { signal }),
  });
}

export class ShellApi {
  constructor(
    readonly http: HttpTransport,
    readonly rpc: RpcClient<RpcMethods>,
  ) {}

  snapshot(signal?: AbortSignal): Promise<OrchestrationShellSnapshot> {
    return loadShellSnapshot(this.http, signal);
  }

  /** Subscribes with `orchestration.subscribeShell`; resubscribes after a dropped socket. */
  watch(options: ShellWatchOptions = {}): AsyncIterable<ShellWatchItem> {
    const rpc = this.rpc;
    return {
      async *[Symbol.asyncIterator]() {
        const { signal } = options;
        let afterSequence = options.afterSequence;
        let emptyAttempts = 0;
        let resumed = false;
        for (;;) {
          if (signal?.aborted) return;
          let received = false;
          try {
            const payload = {
              requestCompletionMarker: true,
              ...(afterSequence === undefined ? {} : { afterSequence }),
            };
            const stream = rpc.stream("orchestration.subscribeShell", payload, {
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
              } else if (value.kind !== "synchronized") {
                if (afterSequence !== undefined && value.sequence <= afterSequence) continue;
                afterSequence = value.sequence;
              }
              yield value;
            }
            return;
          } catch (error) {
            if (signal?.aborted || error instanceof T3InterruptedError) return;
            emptyAttempts = received ? 0 : emptyAttempts + 1;
            const transient = error instanceof T3ConnectionError && error.reason !== "open_failed";
            if (transient && emptyAttempts < 2) {
              resumed = true;
              continue;
            }
            throw error;
          }
        }
      },
    };
  }
}
