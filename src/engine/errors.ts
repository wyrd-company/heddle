// ---
// relationships:
//   implements: heddle
// ---

import type { ExpectedLandings } from "./types.js";

export class BlueprintValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlueprintValidationError";
  }
}

export class InvalidDispositionError extends Error {
  constructor(
    public readonly disposition: string,
    public readonly validDispositions: string[],
  ) {
    super(
      `Invalid disposition ${JSON.stringify(disposition)}. Valid dispositions: ${validDispositions.join(", ")}`,
    );
    this.name = "InvalidDispositionError";
  }
}

export class UnexpectedLandingError extends Error {
  constructor(
    public readonly instanceId: string,
    public readonly expected: ExpectedLandings,
    public readonly actualStatus: string,
  ) {
    super(
      `Instance ${JSON.stringify(instanceId)} landed in ${actualStatus}; expected ${JSON.stringify(expected)}`,
    );
    this.name = "UnexpectedLandingError";
  }
}

export class TransitionConflictError extends Error {
  constructor(public readonly instanceId: string) {
    super(
      `Instance ${JSON.stringify(instanceId)} transition is already claimed`,
    );
    this.name = "TransitionConflictError";
  }
}

export class RebaseTargetNotFoundError extends Error {
  constructor(
    public readonly instanceId: string,
    public readonly targetState: string,
  ) {
    super(
      `Lifecycle state ${JSON.stringify(targetState)} does not exist in the current blueprint for instance ${JSON.stringify(instanceId)}`,
    );
    this.name = "RebaseTargetNotFoundError";
  }
}

export class RebaseTargetNotAwaitableError extends Error {
  constructor(
    public readonly instanceId: string,
    public readonly targetState: string,
  ) {
    super(
      `Lifecycle state ${JSON.stringify(targetState)} is not an awaiting state for instance ${JSON.stringify(instanceId)}`,
    );
    this.name = "RebaseTargetNotAwaitableError";
  }
}

export class RebaseInstanceNotAwaitingError extends Error {
  constructor(
    public readonly instanceId: string,
    public readonly status: string,
  ) {
    super(
      `Instance ${JSON.stringify(instanceId)} cannot be rebased from lifecycle status ${JSON.stringify(status)}`,
    );
    this.name = "RebaseInstanceNotAwaitingError";
  }
}
