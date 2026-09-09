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
      description:
        "Record structured questions for asynchronous answer delivery. Do not act on the question's subject until its answer arrives in a later turn. Continue unrelated work when available; otherwise end this turn. Never create a watcher or poll for the answer.",
      inputSchema: escalationInputSchema,
    },
    async (input) =>
      result(
        await context.escalationCoordinator.escalate(context.binding, input),
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
      description:
        "Answer an escalation only when this session holds its current answering authority",
      inputSchema: escalationAnswerSchema,
    },
    async (input) =>
      result({
        ...(await context.escalationCoordinator.answerAsSession(
          context.binding,
          input,
        )),
        answered: true,
      }),
  );
};

export const workflowMcpEscalationTools = (): WorkflowMcpToolContributor[] => [
  { name: "answer", register: registerAnswer },
  { name: "escalate", register: registerEscalate },
];
