// ---
// relationships:
//   verifies: heddle
// ---

import {
  T3ControlPlaneClient,
  type T3DispatchCommand,
  type T3ProviderDispatchContext,
} from "../control-plane/index.js";
import type { JsonValue } from "../persistence/index.js";
import type { ProductionT3Client } from "./composition.js";

export const storedCorrelationToken = (handoffs: JsonValue[]): string => {
  const stored = handoffs.find(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      value["kind"] === "stage-handoff" &&
      typeof value["correlationToken"] === "string",
  );
  if (
    typeof stored !== "object" ||
    stored === null ||
    Array.isArray(stored) ||
    typeof stored["correlationToken"] !== "string"
  ) {
    throw new Error("Activated stage has no correlation token");
  }
  return stored["correlationToken"];
};

export const recordingT3 = (client: T3ControlPlaneClient) => {
  const dispatches: Array<{
    command: T3DispatchCommand;
    providerContext?: T3ProviderDispatchContext;
  }> = [];
  const t3: ProductionT3Client & {
    readProviderCatalog: T3ControlPlaneClient["readProviderCatalog"];
  } = {
    dispatch: async (command, providerContext) => {
      dispatches.push({
        command,
        ...(providerContext === undefined ? {} : { providerContext }),
      });
      return client.dispatch(command, providerContext);
    },
    getShell: () => client.getShell(),
    getThread: (threadId) => client.getThread(threadId),
    readProviderCatalog: () => client.readProviderCatalog(),
    registerWorkflowMcpProviderSession: (registration) =>
      client.registerWorkflowMcpProviderSession(registration),
    respondToApproval: (threadId, requestId, decision, commandId) =>
      client.respondToApproval(threadId, requestId, decision, commandId),
    respondToUserInput: (threadId, requestId, answers, commandId) =>
      client.respondToUserInput(threadId, requestId, answers, commandId),
  };
  return { dispatches, t3 };
};
