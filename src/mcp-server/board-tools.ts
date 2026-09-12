// ---
// relationships:
//   implements: heddle
// ---

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { BoardTask } from "../board-adapter/index.js";
import type {
  WorkflowMcpBoardAuthority,
  WorkflowMcpToolContext,
  WorkflowMcpToolContributor,
} from "./types.js";

const lifecycle = z.string().regex(/^[a-z][a-z-]*$/);
const dependencyIds = z
  .array(z.number().int().positive())
  .refine((values) => new Set(values).size === values.length, {
    message: "Dependency task IDs must be unique",
  });
const inputSchema = z
  .object({
    body: z.string().trim().min(1),
    dependsOn: dependencyIds.optional(),
    lifecycle,
    operationId: z.string().trim().min(1),
    priority: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1),
  })
  .strict();

type BoardToolInput = z.infer<typeof inputSchema>;
type BoardRecordKind = "finding" | "follow-up";

const result = (value: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value,
});

const taskIdFor = (context: WorkflowMcpToolContext): number => {
  const match = /^task-([1-9][0-9]*)$/.exec(
    context.binding.instance.instanceId,
  );
  if (match === null) {
    throw new Error("Board writes require a task-bound workflow instance");
  }
  const taskId = Number(match[1]);
  const taskContext = context.binding.taskContext;
  if (
    typeof taskContext !== "object" ||
    taskContext === null ||
    Array.isArray(taskContext) ||
    taskContext["id"] !== taskId
  ) {
    throw new Error("Board writes require matching task context authority");
  }
  return taskId;
};

const epicFor = async (
  authority: WorkflowMcpBoardAuthority,
  task: BoardTask,
): Promise<BoardTask> => {
  if (task.parent === undefined) {
    throw new Error(
      `Task ${task.id} is not a direct child of an epic; board record creation is not authorized`,
    );
  }
  const epic = await authority.readTask(task.parent);
  if (epic.parent !== undefined || !epic.tags.includes("type:epic")) {
    throw new Error(
      `Task ${task.id} parent ${task.parent} is not an epic; board record creation is not authorized`,
    );
  }
  return epic;
};

const createRecord = async (
  authority: WorkflowMcpBoardAuthority,
  context: WorkflowMcpToolContext,
  kind: BoardRecordKind,
  input: BoardToolInput,
) => {
  const task = await authority.readTask(taskIdFor(context));
  const epic = await epicFor(authority, task);
  const write = await authority.createRecord(
    {
      body: input.body,
      ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
      kind,
      lifecycle: input.lifecycle,
      operationKey: JSON.stringify([
        context.binding.instance.instanceId,
        context.binding.sessionKey,
        kind,
        input.operationId,
      ]),
      parent: epic.id,
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      status: "backlog",
      title: input.title,
    },
    {
      instanceId: context.binding.instance.instanceId,
      sessionKey: context.binding.sessionKey,
      taskId: task.id,
    },
  );
  return result({
    id: write.task.id,
    kind,
    parent: epic.id,
    replayed: write.replayed,
    status: write.task.status,
  });
};

const contributor = (
  authority: WorkflowMcpBoardAuthority,
  name: "create_finding" | "create_follow_up",
  kind: BoardRecordKind,
): WorkflowMcpToolContributor => ({
  name,
  register: (server: McpServer, context: WorkflowMcpToolContext): void => {
    server.registerTool(
      name,
      {
        description:
          kind === "finding"
            ? "Create an epic child task for a discovered finding"
            : "Create an epic child task for follow-up work",
        inputSchema,
      },
      (input) => createRecord(authority, context, kind, input),
    );
  },
});

export const workflowMcpBoardTools = (
  authority: WorkflowMcpBoardAuthority,
): WorkflowMcpToolContributor[] => [
  contributor(authority, "create_finding", "finding"),
  contributor(authority, "create_follow_up", "follow-up"),
];
