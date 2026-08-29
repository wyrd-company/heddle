// ---
// relationships:
//   implements: heddle
// ---

import type { InstanceRecord, JsonValue } from "../persistence/index.js";

export type StoredStageHandoffCandidate = {
  correlationToken: string;
  handoff: string;
  kind: "stage-handoff";
  parentSessionKey?: string;
  sessionKey: string;
  workflowMcp?: JsonValue;
};

export const isStoredHandoff = (
  value: JsonValue,
): value is StoredStageHandoffCandidate =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  value["kind"] === "stage-handoff" &&
  typeof value["sessionKey"] === "string" &&
  typeof value["correlationToken"] === "string" &&
  typeof value["handoff"] === "string";

export const assertParentSession = (
  record: InstanceRecord,
  input: { parentSessionKey?: string; sessionKey: string },
): void => {
  if (input.parentSessionKey === undefined) return;
  if (input.parentSessionKey === input.sessionKey) {
    throw new TypeError("A stage session cannot be its own parent");
  }
  if (
    !Object.hasOwn(record.state.correlationTokens, input.parentSessionKey) ||
    !record.state.handoffs
      .filter(isStoredHandoff)
      .some(({ sessionKey }) => sessionKey === input.parentSessionKey)
  ) {
    throw new Error(
      `Parent session '${input.parentSessionKey}' is not bound to this instance`,
    );
  }
};
