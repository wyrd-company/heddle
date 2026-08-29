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
import {
  scopedTodoItems,
  todoSubtreeIds,
} from "../subagents/delegation-state.js";
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
      sessionKey:
        context.binding.todoAssignment?.listSessionKey ??
        context.binding.sessionKey,
      stage: context.binding.stage.id,
    },
    (list) => {
      requireActiveAssignment(context, list);
      return mutate(list);
    },
  );

const requireActiveAssignment = (
  context: WorkflowMcpToolContext,
  list: TodoList,
): void => {
  const scope = context.binding.todoAssignment;
  if (scope === undefined) return;
  const matches = (list.assignments ?? []).filter(
    (assignment) =>
      assignment.sessionKey === context.binding.sessionKey &&
      assignment.correlationToken === context.binding.token &&
      assignment.rootItemId === scope.rootItemId &&
      assignment.status === "active",
  );
  if (matches.length !== 1) {
    throw new Error("The subagent todo assignment is not active");
  }
};

const requireInScope = (
  context: WorkflowMcpToolContext,
  list: TodoList,
  id: string,
): void => {
  const root = context.binding.todoAssignment?.rootItemId;
  if (root !== undefined && !todoSubtreeIds(list, root).has(id)) {
    throw new Error(`Todo item is outside the assigned subtree: ${id}`);
  }
  const delegated = (list.assignments ?? []).find(
    (assignment) =>
      assignment.status === "active" &&
      assignment.parentSessionKey === context.binding.sessionKey &&
      todoSubtreeIds(list, assignment.rootItemId).has(id),
  );
  if (delegated !== undefined) {
    throw new Error(
      `Todo item is assigned to child session '${delegated.sessionKey}': ${id}`,
    );
  }
};

const itemIndex = (
  context: WorkflowMcpToolContext,
  list: TodoList,
  id: string,
): number => {
  const index = list.items.findIndex((item) => item.id === id);
  if (index === -1) throw new Error(`Todo item does not exist: ${id}`);
  requireInScope(context, list, id);
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
      const todoList = stageTodoList(
        record,
        context.binding.todoAssignment?.listSessionKey ??
          context.binding.sessionKey,
        context.binding.stage.id,
      ).list;
      requireActiveAssignment(context, todoList);
      const root = context.binding.todoAssignment?.rootItemId;
      return result({
        todoList:
          root === undefined
            ? todoList
            : { ...todoList, items: scopedTodoItems(todoList, root) },
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
        const index = itemIndex(context, list, id);
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
          parentId: z.string().min(1).optional(),
          text: z.string().trim().min(1),
        })
        .strict(),
    },
    ({ parentId, position, text }) => {
      const id = `todo-${globalThis.crypto.randomUUID()}`;
      const todoList = mutateList(context, (list) => {
        const assignmentRoot = context.binding.todoAssignment?.rootItemId;
        const resolvedParentId = parentId ?? assignmentRoot;
        if (resolvedParentId !== undefined) {
          itemIndex(context, list, resolvedParentId);
        }
        const scopedItems =
          assignmentRoot === undefined
            ? list.items
            : scopedTodoItems(list, assignmentRoot);
        const insertion = position ?? scopedItems.length;
        if (insertion > scopedItems.length) {
          throw new Error(`Todo position is outside the list: ${insertion}`);
        }
        const items = [...list.items];
        const globalInsertion =
          insertion === scopedItems.length
            ? assignmentRoot === undefined
              ? items.length
              : Math.max(...scopedItems.map((item) => items.indexOf(item))) + 1
            : items.indexOf(scopedItems[insertion]!);
        items.splice(globalInsertion, 0, {
          checked: false,
          id,
          ...(resolvedParentId === undefined
            ? {}
            : { parentId: resolvedParentId }),
          text,
        });
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
        const index = itemIndex(context, list, id);
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
        const from = itemIndex(context, list, id);
        const root = context.binding.todoAssignment?.rootItemId;
        const scopedItems =
          root === undefined ? list.items : scopedTodoItems(list, root);
        if (position >= scopedItems.length) {
          throw new Error(`Todo position is outside the list: ${position}`);
        }
        const items = [...list.items];
        const [item] = items.splice(from, 1);
        const targetId = scopedItems[position]!.id;
        const insertion =
          targetId === id
            ? from
            : items.findIndex(({ id: candidate }) => candidate === targetId);
        items.splice(insertion, 0, item!);
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
