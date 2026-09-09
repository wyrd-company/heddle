// ---
// relationships:
//   implements: heddle
// ---

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

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
  { name: "escalate", register: registerEscalate },
];
