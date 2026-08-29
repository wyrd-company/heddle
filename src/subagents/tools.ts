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

const result = (value: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value,
});

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
          model: z.string().trim().min(1),
          operationId: z.string().trim().min(1),
          provider: z.string().trim().min(1),
          rootItemId: z.string().trim().min(1),
        })
        .strict(),
    },
    async (input) => result(await coordinator.spawn(context.binding, input)),
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
    name: "spawn",
    register: (server, context) => registerSpawn(coordinator, server, context),
  },
];
