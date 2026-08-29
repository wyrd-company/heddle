// ---
// relationships:
//   implements: heddle
// ---

import type { JsonValue } from "../persistence/index.js";

export interface TodoItem extends Record<string, JsonValue> {
  checked: boolean;
  id: string;
  text: string;
}

export interface TodoList extends Record<string, JsonValue> {
  items: TodoItem[];
  sessionKey: string;
  stage: string;
  template: string;
}

export interface TodoState extends Record<string, JsonValue> {
  format: "heddle.todo-state";
  lists: TodoList[];
  version: 1;
}

export interface TodoTemplateItem {
  id: string;
  text: string;
}

export interface TodoTemplate {
  items: TodoTemplateItem[];
}
