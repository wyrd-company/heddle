// ---
// relationships:
//   implements: heddle
// ---

import type { InstanceRecord, JsonValue } from "../persistence/index.js";
import {
  CorrelationTokenError,
  resolveWorkflowMcpSessionBinding,
} from "../mcp-server/session-binding.js";
import type { InstanceStateStore } from "./correlation-token.js";
import type { HandoffAuthenticationBinding } from "./handoff-renderer.js";

export type StoredStageHandoffCandidate = {
  correlationToken: string;
  handoff: string;
  kind: "stage-handoff";
  parentSessionKey?: string;
  sessionKey: string;
  renderedHandoffAuthentication?: HandoffAuthenticationBinding;
  renderedHandoff?: string;
  todoAssignment?: {
    listSessionKey: string;
    rootItemId: string;
  };
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
  typeof value["handoff"] === "string" &&
  (value["todoAssignment"] === undefined ||
    (typeof value["todoAssignment"] === "object" &&
      value["todoAssignment"] !== null &&
      !Array.isArray(value["todoAssignment"]) &&
      typeof value["todoAssignment"]["listSessionKey"] === "string" &&
      typeof value["todoAssignment"]["rootItemId"] === "string"));

export const assertParentSession = (
  store: InstanceStateStore,
  record: InstanceRecord,
  input: { parentSessionKey?: string; sessionKey: string },
): void => {
  if (input.parentSessionKey === undefined) return;
  if (input.parentSessionKey === input.sessionKey) {
    throw new TypeError("A stage session cannot be its own parent");
  }
  const token = record.state.correlationTokens[input.parentSessionKey];
  let isCanonicalParent = false;
  if (token !== undefined) {
    try {
      const binding = resolveWorkflowMcpSessionBinding(store, token);
      isCanonicalParent =
        binding.instance.instanceId === record.instanceId &&
        binding.sessionKey === input.parentSessionKey &&
        binding.stage.tools.includes("answer");
    } catch (error) {
      if (!(error instanceof CorrelationTokenError)) throw error;
    }
  }
  if (!isCanonicalParent) {
    throw new Error(
      `Parent session '${input.parentSessionKey}' is not bound to this instance`,
    );
  }
};
