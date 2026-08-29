// ---
// relationships:
//   implements: heddle
// ---

import type { InstanceState, JsonValue } from "../persistence/index.js";

const claimField = "mcpDispositionClaims";

const lifecycleContext = (state: InstanceState): Record<string, JsonValue> => {
  const context = state.flowcraftContext;
  if (
    typeof context !== "object" ||
    context === null ||
    Array.isArray(context)
  ) {
    throw new Error("Instance does not contain lifecycle authority state");
  }
  return context;
};

const claimsFrom = (state: InstanceState): Record<string, string> => {
  const value = lifecycleContext(state)[claimField];
  if (value === undefined) return {};
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.values(value).some(
      (operationId) =>
        typeof operationId !== "string" || operationId.trim() === "",
    )
  ) {
    throw new Error("Instance has invalid MCP disposition claims");
  }
  return value as Record<string, string>;
};

export const dispositionClaimFor = (
  state: InstanceState,
  sessionKey: string,
): string | undefined => claimsFrom(state)[sessionKey];

export const withDispositionClaim = (
  state: InstanceState,
  sessionKey: string,
  operationId: string,
): InstanceState => {
  const context = lifecycleContext(state);
  return {
    ...state,
    flowcraftContext: {
      ...context,
      [claimField]: {
        ...claimsFrom(state),
        [sessionKey]: operationId,
      },
    },
  };
};
