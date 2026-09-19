// ---
// relationships:
//   implements: github-binding-and-intake
// ---
import type { RunStore } from "../engine/store.js";
import type { IntakeAttempt } from "./store.js";
import type { IssueSnapshot } from "./snapshot.js";

/** A run that has not ended still owns its issue; issue changes reach it. */
export function attemptIsAlive(store: RunStore, runId: string): boolean {
  const row = store.db.prepare("SELECT 1 FROM runs WHERE id=?").get(runId);
  if (row === undefined) return false;
  const status = store.get(runId).status;
  return status !== "completed" && status !== "failed";
}

export interface AttemptInputs {
  readonly issue: IssueSnapshot;
  readonly commit: string;
  /** The process has started since the last attempt ended. */
  readonly restarted: boolean;
}

/**
 * A new attempt runs only when something changed since the last one ended:
 * the issue, the resolved intake revision, or the life of the process. There
 * is no clock here, and an unchanged issue starts nothing however often it is
 * polled or delivered.
 */
export function attemptDue(
  store: RunStore,
  recorded: IntakeAttempt | undefined,
  inputs: AttemptInputs,
): boolean {
  if (recorded === undefined) return true;
  if (attemptIsAlive(store, recorded.runId)) return false;
  return (
    inputs.restarted ||
    recorded.snapshot !== JSON.stringify(inputs.issue) ||
    recorded.commit !== inputs.commit
  );
}

/** Attempt one keeps the issue's own run id; later attempts number themselves. */
export function nextAttempt(
  issueId: string,
  recorded: IntakeAttempt | undefined,
  inputs: AttemptInputs,
): IntakeAttempt {
  const attempt = (recorded?.attempt ?? 0) + 1;
  return {
    issueId,
    attempt,
    runId:
      attempt === 1
        ? `intake:${issueId}`
        : `intake:${issueId}:${String(attempt)}`,
    commit: inputs.commit,
    snapshot: JSON.stringify(inputs.issue),
  };
}
