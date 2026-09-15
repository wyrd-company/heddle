// ---
// relationships:
//   implements: heddle
// ---

/**
 * Raised when a board operation is refused for the same reason the kanban-md
 * CLI refuses it. The `code` mirrors the CLI's error vocabulary so callers can
 * distinguish a refusal from an I/O failure.
 */
export class BoardStoreError extends Error {
  public constructor(
    public readonly code: BoardStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BoardStoreError";
  }
}

export type BoardStoreErrorCode =
  | "board-not-found"
  | "claim-required"
  | "invalid-class"
  | "invalid-config"
  | "invalid-priority"
  | "invalid-status"
  | "invalid-task"
  | "task-claimed"
  | "task-not-found"
  | "dependency-not-found"
  | "self-reference"
  | "wip-limit-exceeded"
  | "id-allocation-failed";
