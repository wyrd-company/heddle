/**
 * Turn-state rules shared by the projection and the values derived from it.
 * Mirrors the server projector's `settledTurnStateForSessionStatus`.
 */
import type {
  OrchestrationLatestTurnState,
  OrchestrationSession,
} from "../schemas/orchestration/read-model.js";

export type SettledTurnState = "completed" | "interrupted" | "error";

/** Leaving "running" settles a running latest turn; `null` while (re)starting or running. */
export function settledTurnStateForSessionStatus(
  status: OrchestrationSession["status"],
): SettledTurnState | null {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    default:
      return null;
  }
}

export function isSettledTurnState(state: OrchestrationLatestTurnState): state is SettledTurnState {
  return state === "completed" || state === "interrupted" || state === "error";
}

/** The latest-turn state a checkpoint status implies; a missing git ref is not an interruption. */
export function checkpointStatusToLatestTurnState(status: string): "completed" | "error" {
  return status === "error" ? "error" : "completed";
}
