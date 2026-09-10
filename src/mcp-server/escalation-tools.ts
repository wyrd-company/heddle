// ---
// relationships:
//   implements: heddle
// ---

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { escalationAnswerSchema } from "./escalation-coordinator.js";
import type {
  WorkflowMcpToolContext,
  WorkflowMcpToolContributor,
} from "./types.js";

const result = (value: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value,
});

const registerAnswer = (
  server: McpServer,
  context: WorkflowMcpToolContext,
): void => {
  server.registerTool(
    "answer",
    {
      description:
        "Answer every question in the assigned request in one call, keyed by question ID. Each answer supplies selectedOptions or text (never both), plus required reasoning. Use offered option labels, respecting single or multiple selection. A question with no options requires text. Only the current answering authority may answer.",
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

const registerDecline = (
  server: McpServer,
  context: WorkflowMcpToolContext,
): void => {
  server.registerTool(
    "decline",
    {
      description:
        "Decline the bound adjudication when the decision belongs to the operator",
      inputSchema: z
        .object({
          reason: z.string().trim().min(1).max(4_000),
          reasoning: z.string().trim().min(1).max(4_000),
        })
        .strict(),
    },
    async (input) => {
      await context.escalationCoordinator.declineAdjudication(
        context.binding,
        input,
      );
      return result({ declined: true });
    },
  );
};

export const workflowMcpEscalationTools = (): WorkflowMcpToolContributor[] => [
  { name: "answer", register: registerAnswer },
  { name: "decline", register: registerDecline },
];
