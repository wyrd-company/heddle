// ---
// relationships:
//   implements: heddle
// ---

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { JsonValue } from "../persistence/index.js";
import type {
  WorkflowMcpDisposition,
  WorkflowMcpToolContext,
  WorkflowMcpToolContributor,
} from "./types.js";
import { advanceOperationId } from "./operations.js";

const jsonObject = z.record(z.string(), z.json());

const result = (value: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value,
});

const dispositionSchema = (
  dispositions: WorkflowMcpDisposition[],
): z.ZodType<string> => {
  if (dispositions.length === 0) {
    throw new Error("advance requires at least one stage disposition");
  }
  const literals = dispositions.map(({ description, name }) =>
    z.literal(name).describe(description),
  );
  return literals.length === 1
    ? literals[0]!
    : z.union(
        literals as [
          z.ZodLiteral<string>,
          z.ZodLiteral<string>,
          ...z.ZodLiteral<string>[],
        ],
      );
};

const registerAdvance = (
  server: McpServer,
  context: WorkflowMcpToolContext,
): void => {
  server.registerTool(
    "advance",
    {
      description: "Disposition the current workflow stage",
      inputSchema: z
        .object({
          disposition: dispositionSchema(context.binding.dispositions),
          output: jsonObject.optional(),
        })
        .strict(),
    },
    async ({ disposition, output }) => {
      context.escalationCoordinator.requireNoPendingForSession(
        context.binding.instance.instanceId,
        context.binding.sessionKey,
      );
      const snapshot = await context.lifecycle.resume({
        disposition,
        instanceId: context.binding.instance.instanceId,
        operationId: advanceOperationId(context.binding.sessionKey),
        ...(output === undefined
          ? {}
          : { output: output as Record<string, JsonValue> }),
      });
      return result(snapshot as unknown as Record<string, unknown>);
    },
  );
};

const registerGetTaskContext = (
  server: McpServer,
  context: WorkflowMcpToolContext,
): void => {
  server.registerTool(
    "get_task_context",
    {
      description: "Get the task contract bound to this stage session",
      inputSchema: z.object({}).strict(),
    },
    () => result({ taskContext: context.binding.taskContext }),
  );
};

const registerReportBlocked = (
  server: McpServer,
  context: WorkflowMcpToolContext,
): void => {
  server.registerTool(
    "report_blocked",
    {
      description: "Report that the current workflow stage is blocked",
      inputSchema: z.object({ message: z.string().trim().min(1) }).strict(),
    },
    ({ message }) => {
      const event = context.persistence.appendEvent(
        context.binding.instance.instanceId,
        "mcp:blocked-reported",
        {
          message,
          sessionKey: context.binding.sessionKey,
          stage: context.binding.stage.id,
        },
      );
      return result({ recorded: true, sequence: event.sequence });
    },
  );
};

export const workflowMcpCoreTools = (): WorkflowMcpToolContributor[] => [
  { name: "advance", register: registerAdvance },
  { name: "get_task_context", register: registerGetTaskContext },
  { name: "report_blocked", register: registerReportBlocked },
];
