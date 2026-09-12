// ---
// relationships:
//   implements: heddle
// ---

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type {
  WorkflowMcpToolContext,
  WorkflowMcpToolContributor,
} from "../mcp-server/types.js";
import type { SubagentCoordinator } from "./coordinator.js";
import { ProviderSelectionError } from "../control-plane/index.js";

const result = (value: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value,
});

const selectionResult = async (
  action: () => Promise<Record<string, unknown>>,
) => {
  try {
    return result(await action());
  } catch (error) {
    if (!(error instanceof ProviderSelectionError)) throw error;
    const structuredContent = {
      error: { message: error.message, reason: error.reason },
    };
    return {
      content: [{ type: "text" as const, text: error.message }],
      isError: true,
      structuredContent,
    };
  }
};

const registerSpawn = (
  coordinator: SubagentCoordinator,
  server: McpServer,
  context: WorkflowMcpToolContext,
): void => {
  server.registerTool(
    "spawn",
    {
      description:
        "Assign a todo subtree and start an asynchronous child session",
      inputSchema: z
        .object({
          operationId: z.string().trim().min(1),
          providerAlias: z.string().trim().min(1),
          rootItemId: z.string().trim().min(1),
        })
        .strict(),
    },
    async (input) =>
      selectionResult(() => coordinator.spawn(context.binding, input)),
  );
};

const registerListProviders = (
  coordinator: SubagentCoordinator,
  server: McpServer,
): void => {
  server.registerTool(
    "list_providers",
    {
      description: "List the configured provider aliases available to spawn",
      inputSchema: z.object({}).strict(),
    },
    async () => selectionResult(() => coordinator.listProviders()),
  );
};

const registerLiveness = (
  coordinator: SubagentCoordinator,
  server: McpServer,
  context: WorkflowMcpToolContext,
): void => {
  server.registerTool(
    "liveness",
    {
      description: "Observe whether one assigned child is working or crashed",
      inputSchema: z.object({ sessionKey: z.string().trim().min(1) }).strict(),
    },
    async ({ sessionKey }) =>
      result(await coordinator.liveness(context.binding, sessionKey)),
  );
};

export const workflowMcpSubagentTools = (
  coordinator: SubagentCoordinator,
): WorkflowMcpToolContributor[] => [
  {
    name: "liveness",
    register: (server, context) =>
      registerLiveness(coordinator, server, context),
  },
  {
    name: "list_providers",
    register: (server) => registerListProviders(coordinator, server),
  },
  {
    name: "spawn",
    register: (server, context) => registerSpawn(coordinator, server, context),
  },
];
