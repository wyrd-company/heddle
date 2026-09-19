// ---
// relationships:
//   implements: node-types
// ---
import type { ThreadWatchItem } from "../t3code/index.js";
import type { PassInvocation } from "./types.js";
export class PassWatchState {
  synchronized = false;
  readonly settlements: ThreadWatchItem[] = [];
  readonly announced = new Set<string>();
  readonly controller = new AbortController();
  readonly ready: Promise<void>;
  resolve = (): void => {
    /* Installed by the synchronous Promise initializer. */
  };
  reject: (error: unknown) => void = (): void => {
    /* Installed by the synchronous Promise initializer. */
  };
  constructor(readonly item: PassInvocation) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // Startup errors are also observed by the service's run-failure handler.
    void this.ready.catch(() => {
      /* recover() receives the original rejection. */
    });
  }
}

/** Derive from our durable projection too: a replay can contain only a ready/null session. */
export function queueSettlement(watch: PassWatchState): void {
  const thread = watch.item.projection,
    turn = thread?.latestTurn;
  if (
    !thread ||
    !turn ||
    !watch.item.view.turns[turn.turnId] ||
    watch.announced.has(turn.turnId)
  )
    return;
  const state = turn.state;
  if (state !== "completed" && state !== "interrupted" && state !== "error")
    return;
  watch.announced.add(turn.turnId);
  watch.settlements.push({
    kind: "turn-settled",
    outcome: {
      thread,
      turnId: turn.turnId,
      state:
        state === "completed"
          ? "completed"
          : state === "interrupted"
            ? "interrupted"
            : "error",
    },
  });
}

export function observingTail(item: PassInvocation): boolean {
  const turn = item.projection?.latestTurn;
  return (
    item.view.started &&
    turn?.state === "running" &&
    !!item.view.turns[turn.turnId]
  );
}
