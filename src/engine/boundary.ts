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
        message: failureMessage(cleanupError),
      });
    }
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return typeof value === "symbol" ? value.toString() : JSON.stringify(value);
}

interface Caused {
  readonly message?: unknown;
  readonly originalError?: unknown;
  readonly cause?: unknown;
}

/** A failure reads its own causes, so the reason is not hidden behind a node id. */
export function failureMessage(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && parts.length < 8) {
    const caused =
      typeof current === "object" ? (current as Caused) : undefined;
    const message =
      typeof caused?.message === "string" ? caused.message : stringify(current);
    if (!parts.includes(message)) parts.push(message);
    current = caused?.originalError ?? caused?.cause;
  }
  return parts.join(": ");
}

export function recordFailure(
  store: RunStore,
  runId: string,
  error: unknown,
): void {
  const message = failureMessage(error);
  store.transaction(() => {
    const status = store.get(runId).status;
    if (status !== "completed" && status !== "failed") {
      store.status(runId, "failed");
      store.event(runId, "failure", { message });
    }
    store.event(runId, "attention", { message });
  });
}
