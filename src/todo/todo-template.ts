// ---
// relationships:
//   implements: heddle
// ---

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { JsonValue } from "../persistence/index.js";
import type { TodoItem, TodoList, TodoState, TodoTemplate } from "./types.js";

const artifactId = /^[a-z]+(?:-[a-z]+)*$/;
const placeholder =
  /\{\{task\.([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*)\}\}/g;

const isObject = (value: JsonValue): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readTemplate = async (
  repositoryRoot: string,
  templateId: string,
): Promise<TodoTemplate> => {
  if (!artifactId.test(templateId)) {
    throw new TypeError(
      `Todo template has an invalid artifact ID: ${templateId}`,
    );
  }
  const serialized = await readFile(
    join(repositoryRoot, "todo-templates", `${templateId}.json`),
    "utf8",
  );
  const value = JSON.parse(serialized) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    !("items" in value) ||
    !Array.isArray(value.items) ||
    value.items.length === 0 ||
    value.items.some(
      (item) =>
        typeof item !== "object" ||
        item === null ||
        !("id" in item) ||
        typeof item.id !== "string" ||
        !artifactId.test(item.id) ||
        !("text" in item) ||
        typeof item.text !== "string" ||
        item.text.trim() === "",
    )
  ) {
    throw new TypeError(`Todo template is invalid: ${templateId}`);
  }
  return value as TodoTemplate;
};

const taskValue = (taskContract: JsonValue, path: string): string => {
  let current = taskContract;
  for (const segment of path.split(".")) {
    if (!isObject(current) || !Object.hasOwn(current, segment)) {
      throw new TypeError(
        `Todo template placeholder has no task value: task.${path}`,
      );
    }
    current = current[segment]!;
  }
  if (
    current === null ||
    (typeof current !== "string" &&
      typeof current !== "number" &&
      typeof current !== "boolean")
  ) {
    throw new TypeError(
      `Todo template placeholder is not scalar: task.${path}`,
    );
  }
  return String(current);
};

const instantiateText = (text: string, taskContract: JsonValue): string =>
  text.replace(placeholder, (_match, path: string) =>
    taskValue(taskContract, path),
  );

export const emptyTodoState = (): TodoState => ({
  format: "heddle.todo-state",
  lists: [],
  version: 1,
});

export const isTodoState = (value: JsonValue): value is TodoState => {
  if (
    !isObject(value) ||
    value["format"] !== "heddle.todo-state" ||
    value["version"] !== 1 ||
    !Array.isArray(value["lists"])
  ) {
    return false;
  }
  const sessionKeys = new Set<string>();
  for (const candidate of value["lists"]) {
    if (
      !isObject(candidate) ||
      typeof candidate["sessionKey"] !== "string" ||
      candidate["sessionKey"].trim() === "" ||
      sessionKeys.has(candidate["sessionKey"]) ||
      typeof candidate["stage"] !== "string" ||
      candidate["stage"].trim() === "" ||
      typeof candidate["template"] !== "string" ||
      !artifactId.test(candidate["template"]) ||
      !Array.isArray(candidate["items"])
    ) {
      return false;
    }
    sessionKeys.add(candidate["sessionKey"]);
    const itemIds = new Set<string>();
    for (const item of candidate["items"]) {
      if (
        !isObject(item) ||
        typeof item["id"] !== "string" ||
        item["id"].trim() === "" ||
        itemIds.has(item["id"]) ||
        typeof item["text"] !== "string" ||
        item["text"].trim() === "" ||
        typeof item["checked"] !== "boolean"
      ) {
        return false;
      }
      itemIds.add(item["id"]);
    }
  }
  return true;
};

export const instantiateTodoList = async (input: {
  repositoryRoot: string;
  sessionKey: string;
  stage: string;
  taskContract: JsonValue;
  templateId: string;
}): Promise<TodoList> => {
  const template = await readTemplate(input.repositoryRoot, input.templateId);
  const ids = template.items.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw new TypeError(
      `Todo template contains duplicate item IDs: ${input.templateId}`,
    );
  }
  const items: TodoItem[] = template.items.map(({ id, text }) => {
    const instantiated = instantiateText(text, input.taskContract);
    if (instantiated.includes("{{") || instantiated.includes("}}")) {
      throw new TypeError(
        `Todo template contains invalid placeholder syntax: ${input.templateId}`,
      );
    }
    return { checked: false, id, text: instantiated };
  });
  return {
    items,
    sessionKey: input.sessionKey,
    stage: input.stage,
    template: input.templateId,
  };
};
