// ---
// relationships:
//   implements: heddle
// ---

import type { McpServer } from "@modelcontextprotocol/server";

import {
  escalationAnswerSchema,
  escalationInputSchema,
} from "./escalation-coordinator.js";
import type {
  WorkflowMcpToolContext,
  WorkflowMcpToolContributor,
} from "./types.js";

const result = (value: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value,
});

const registerEscalate = (
  server: McpServer,
  context: WorkflowMcpToolContext,
): void => {
  server.registerTool(
    "escalate",
    {
      description: "Ask blocking structured questions and wait for answers",
      inputSchema: escalationInputSchema,
    },
    async (input, request) =>
      result(
        await context.escalationCoordinator.escalate(
          context.binding,
          input,
          request.mcpReq.signal,
        ),
      ),
  );
};

const registerAnswer = (
  server: McpServer,
  context: WorkflowMcpToolContext,
): void => {
  server.registerTool(
    "answer",
    {
      description: "Answer a blocking escalation from one of your children",
      inputSchema: escalationAnswerSchema,
    },
    (input) =>
      result({
        ...context.escalationCoordinator.answerAsSession(
          context.binding,
          input,
        ),
        answered: true,
      }),
  );
};

export const workflowMcpEscalationTools = (): WorkflowMcpToolContributor[] => [
  { name: "answer", register: registerAnswer },
  { name: "escalate", register: registerEscalate },
];
