// ---
// relationships:
//   implements: engine-and-run-model
// ---
import type { RunStore } from "./store.js";
import type { EngineOptions } from "./types.js";

export async function reconcileBoundary(
  store: RunStore,
  onBoundary: EngineOptions["onBoundary"],
  runId: string,
): Promise<void> {
  try {
    await onBoundary?.(store.get(runId));
  } catch (error) {
    recordFailure(store, runId, error);
    // A failed start can leave an external registration to retire.
    try {
      await onBoundary?.(store.get(runId));
    } catch (cleanupError) {
      store.event(runId, "attention", {
        message:
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
      });
    }
  }
}

export function recordFailure(
  store: RunStore,
  runId: string,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  store.transaction(() => {
    const status = store.get(runId).status;
    if (status !== "completed" && status !== "failed") {
      store.status(runId, "failed");
      store.event(runId, "failure", { message });
    }
    store.event(runId, "attention", { message });
  });
}
