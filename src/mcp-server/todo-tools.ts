// ---
// relationships:
//   implements: heddle
// ---

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  mutateStageTodoList,
  stageTodoList,
  type TodoList,
} from "../todo/index.js";
import type {
  WorkflowMcpToolContext,
  WorkflowMcpToolContributor,
} from "./types.js";

const result = (value: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value,
});

const mutateList = (
  context: WorkflowMcpToolContext,
  mutate: (list: TodoList) => TodoList,
): TodoList =>
  mutateStageTodoList(
    context.persistence,
    {
      instanceId: context.binding.instance.instanceId,
      sessionKey: context.binding.sessionKey,
      stage: context.binding.stage.id,
    },
    mutate,
  );

const itemIndex = (list: TodoList, id: string): number => {
  const index = list.items.findIndex((item) => item.id === id);
  if (index === -1) throw new Error(`Todo item does not exist: ${id}`);
  return index;
};

const registerList = (
  server: McpServer,
  context: WorkflowMcpToolContext,
): void => {
  server.registerTool(
    "todo_list",
    {
      description: "List the todo items for this stage session",
      inputSchema: z.object({}).strict(),
    },
    () => {
      const record = context.persistence.getInstance(
        context.binding.instance.instanceId,
      );
      if (record === undefined)
        throw new Error("The workflow instance is absent");
      return result({
        todoList: stageTodoList(
          record,
          context.binding.sessionKey,
          context.binding.stage.id,
        ).list,
      });
    },
  );
};

const registerCheck = (
  server: McpServer,
  context: WorkflowMcpToolContext,
): void => {
  server.registerTool(
    "todo_check",
    {
      description: "Set whether one todo item is checked",
      inputSchema: z
        .object({ checked: z.boolean().default(true), id: z.string().min(1) })
        .strict(),
    },
    ({ checked, id }) => {
      const todoList = mutateList(context, (list) => {
        const index = itemIndex(list, id);
        return {
          ...list,
          items: list.items.map((item, candidateIndex) =>
            candidateIndex === index ? { ...item, checked } : item,
          ),
        };
      });
      return result({ todoList });
    },
  );
};

const registerAdd = (
  server: McpServer,
  context: WorkflowMcpToolContext,
): void => {
  server.registerTool(
    "todo_add",
    {
      description: "Add an item to this stage session's todo list",
      inputSchema: z
        .object({
          position: z.number().int().min(0).optional(),
          text: z.string().trim().min(1),
        })
        .strict(),
    },
    ({ position, text }) => {
      const id = `todo-${globalThis.crypto.randomUUID()}`;
      const todoList = mutateList(context, (list) => {
        const insertion = position ?? list.items.length;
        if (insertion > list.items.length) {
          throw new Error(`Todo position is outside the list: ${insertion}`);
        }
        const items = [...list.items];
        items.splice(insertion, 0, { checked: false, id, text });
        return { ...list, items };
      });
      return result({ id, todoList });
    },
  );
};

const registerEdit = (
  server: McpServer,
  context: WorkflowMcpToolContext,
): void => {
  server.registerTool(
    "todo_edit",
    {
      description: "Edit the text of one todo item",
      inputSchema: z
        .object({ id: z.string().min(1), text: z.string().trim().min(1) })
        .strict(),
    },
    ({ id, text }) => {
      const todoList = mutateList(context, (list) => {
        const index = itemIndex(list, id);
        return {
          ...list,
          items: list.items.map((item, candidateIndex) =>
            candidateIndex === index ? { ...item, text } : item,
          ),
        };
      });
      return result({ todoList });
    },
  );
};

const registerReorder = (
  server: McpServer,
  context: WorkflowMcpToolContext,
): void => {
  server.registerTool(
    "todo_reorder",
    {
      description: "Move one todo item to a zero-based position",
      inputSchema: z
        .object({
          id: z.string().min(1),
          position: z.number().int().min(0),
        })
        .strict(),
    },
    ({ id, position }) => {
      const todoList = mutateList(context, (list) => {
        const from = itemIndex(list, id);
        if (position >= list.items.length) {
          throw new Error(`Todo position is outside the list: ${position}`);
        }
        const items = [...list.items];
        const [item] = items.splice(from, 1);
        items.splice(position, 0, item!);
        return { ...list, items };
      });
      return result({ todoList });
    },
  );
};

export const workflowMcpTodoTools = (): WorkflowMcpToolContributor[] => [
  { name: "todo_list", register: registerList },
  { name: "todo_check", register: registerCheck },
  { name: "todo_add", register: registerAdd },
  { name: "todo_edit", register: registerEdit },
  { name: "todo_reorder", register: registerReorder },
];
