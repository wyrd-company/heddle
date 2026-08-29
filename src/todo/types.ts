// ---
// relationships:
//   implements: heddle
// ---

import type { JsonValue } from "../persistence/index.js";

export type TodoItem = Record<string, JsonValue> & {
  checked: boolean;
  id: string;
  parentId?: string;
  text: string;
};

export type TodoAssignment = Record<string, JsonValue> & {
  bootstrap: {
    createCommandId: string;
    createdAt: string;
    messageId: string;
    turnCommandId: string;
  };
  correlationToken: string;
  depth: number;
  model: string;
  operationId: string;
  parentSessionKey: string;
  parentThreadId: string;
  provider: string;
  rootItemId: string;
  sessionKey: string;
  status: "active" | "stopped";
  stopNotification?: {
    commandId: string;
    createdAt: string;
    messageId: string;
    status: "issued" | "completed";
  };
  threadId: string;
};

export type TodoList = Record<string, JsonValue> & {
  assignments?: TodoAssignment[];
  items: TodoItem[];
  sessionKey: string;
  stage: string;
  template: string;
};

export interface TodoState extends Record<string, JsonValue> {
  format: "heddle.todo-state";
  lists: TodoList[];
  version: 1;
}

export interface TodoTemplateItem {
  id: string;
  parentId?: string;
  text: string;
}

export interface TodoTemplate {
  items: TodoTemplateItem[];
}
