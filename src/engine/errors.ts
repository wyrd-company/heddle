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
