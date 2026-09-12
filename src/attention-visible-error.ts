// ---
// relationships:
//   implements: heddle
// ---

import { describeError } from "./error-details.js";

export class AttentionVisibleError extends Error {
  constructor(cause: unknown) {
    super(describeError(cause), { cause });
    this.name = "AttentionVisibleError";
  }
}
