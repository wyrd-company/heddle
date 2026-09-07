// ---
// relationships:
//   implements: heddle
// ---

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  isResolvedSessionBinding,
  type JsonValue,
} from "../persistence/index.js";
import type {
  TodoAssignment,
  TodoItem,
  TodoList,
  TodoState,
  TodoTemplate,
} from "./types.js";
import { todoSubtreeIds, validTodoTree } from "./todo-tree.js";

const artifactId = /^[a-z]+(?:-[a-z]+)*$/;
const placeholder =
  /\{\{task\.([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*)\}\}/g;

const isObject = (value: unknown): value is Record<string, JsonValue> =>
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

const hasInvalidPlaceholderSyntax = (text: string): boolean =>
  /[{}]/.test(text.replace(placeholder, ""));

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
      !Array.isArray(candidate["items"]) ||
      (candidate["assignments"] !== undefined &&
        !Array.isArray(candidate["assignments"]))
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
        typeof item["checked"] !== "boolean" ||
        (item["parentId"] !== undefined && typeof item["parentId"] !== "string")
      ) {
        return false;
      }
      itemIds.add(item["id"]);
    }
    if (!validTodoTree(candidate["items"] as TodoItem[])) return false;
    const assignmentSessions = new Set<string>();
    const assignmentOperations = new Set<string>();
    for (const assignment of candidate["assignments"] ?? []) {
      if (
        !isObject(assignment) ||
        !isResolvedSessionBinding(assignment["binding"]) ||
        !isObject(assignment["bootstrap"]) ||
        typeof assignment["bootstrap"]["createCommandId"] !== "string" ||
        assignment["bootstrap"]["createCommandId"].trim() === "" ||
        typeof assignment["bootstrap"]["createdAt"] !== "string" ||
        assignment["bootstrap"]["createdAt"].trim() === "" ||
        typeof assignment["bootstrap"]["messageId"] !== "string" ||
        assignment["bootstrap"]["messageId"].trim() === "" ||
        typeof assignment["bootstrap"]["turnCommandId"] !== "string" ||
        assignment["bootstrap"]["turnCommandId"].trim() === "" ||
        typeof assignment["correlationToken"] !== "string" ||
        assignment["correlationToken"].trim() === "" ||
        typeof assignment["depth"] !== "number" ||
        !Number.isSafeInteger(assignment["depth"]) ||
        assignment["depth"] < 1 ||
        typeof assignment["model"] !== "string" ||
        assignment["model"].trim() === "" ||
        typeof assignment["operationId"] !== "string" ||
        assignment["operationId"].trim() === "" ||
        typeof assignment["parentSessionKey"] !== "string" ||
        assignment["parentSessionKey"].trim() === "" ||
        typeof assignment["parentThreadId"] !== "string" ||
        assignment["parentThreadId"].trim() === "" ||
        typeof assignment["provider"] !== "string" ||
        assignment["provider"].trim() === "" ||
        typeof assignment["rootItemId"] !== "string" ||
        !itemIds.has(assignment["rootItemId"]) ||
        typeof assignment["sessionKey"] !== "string" ||
        assignment["sessionKey"].trim() === "" ||
        assignmentSessions.has(assignment["sessionKey"]) ||
        assignmentOperations.has(assignment["operationId"]) ||
        (assignment["status"] !== "active" &&
          assignment["status"] !== "stopped") ||
        typeof assignment["threadId"] !== "string" ||
        assignment["threadId"].trim() === ""
      ) {
        return false;
      }
      if (
        assignment["binding"].sessionKey !== assignment["sessionKey"] ||
        assignment["binding"].threadId !== assignment["threadId"] ||
        assignment["binding"].providerInstanceId !== assignment["provider"] ||
        assignment["binding"].modelSlug !== assignment["model"]
      ) {
        return false;
      }
      const notice = assignment["stopNotification"];
      if (
        notice !== undefined &&
        (!isObject(notice) ||
          typeof notice["commandId"] !== "string" ||
          notice["commandId"].trim() === "" ||
          typeof notice["createdAt"] !== "string" ||
          notice["createdAt"].trim() === "" ||
          typeof notice["messageId"] !== "string" ||
          notice["messageId"].trim() === "" ||
          typeof notice["message"] !== "string" ||
          notice["message"].trim() === "" ||
          (notice["phase"] !== "absent" &&
            notice["phase"] !== "completed" &&
            notice["phase"] !== "failed") ||
          (notice["status"] !== "issued" && notice["status"] !== "completed"))
      ) {
        return false;
      }
      const ancestorStop = assignment["ancestorStop"];
      if (
        ancestorStop !== undefined &&
        (!isObject(ancestorStop) ||
          typeof ancestorStop["ancestorSessionKey"] !== "string" ||
          ancestorStop["ancestorSessionKey"].trim() === "" ||
          typeof ancestorStop["createdAt"] !== "string" ||
          ancestorStop["createdAt"].trim() === "")
      ) {
        return false;
      }
      if (
        (assignment["status"] === "active" &&
          (notice !== undefined || ancestorStop !== undefined)) ||
        (assignment["status"] === "stopped" &&
          (notice === undefined) === (ancestorStop === undefined))
      ) {
        return false;
      }
      assignmentSessions.add(assignment["sessionKey"]);
      assignmentOperations.add(assignment["operationId"]);
    }
    const assignments = (candidate["assignments"] ?? []) as TodoAssignment[];
    for (const assignment of assignments) {
      const visited = new Set<string>();
      let parentSessionKey = assignment.parentSessionKey;
      const directParent = assignments.find(
        (possibleParent) => possibleParent.sessionKey === parentSessionKey,
      );
      if (
        parentSessionKey === candidate["sessionKey"]
          ? assignment.depth !== 1
          : directParent === undefined ||
            assignment.depth !== directParent.depth + 1
      ) {
        return false;
      }
      while (parentSessionKey !== candidate["sessionKey"]) {
        if (visited.has(parentSessionKey)) return false;
        visited.add(parentSessionKey);
        const parent = assignments.find(
          (possibleParent) => possibleParent.sessionKey === parentSessionKey,
        );
        if (parent === undefined) return false;
        if (assignment.status === "active" && parent.status !== "active") {
          return false;
        }
        parentSessionKey = parent.parentSessionKey;
      }
      if (assignment.ancestorStop !== undefined) {
        const ancestor = assignments.find(
          ({ sessionKey }) =>
            sessionKey === assignment.ancestorStop?.ancestorSessionKey,
        );
        if (
          ancestor === undefined ||
          ancestor.status !== "stopped" ||
          !visited.has(ancestor.sessionKey)
        ) {
          return false;
        }
      }
    }
    const activeAssignments = assignments.filter(
      ({ status }) => status === "active",
    );
    const ancestorsFor = (assignment: TodoAssignment): Set<string> => {
      const ancestors = new Set<string>();
      let parentSessionKey = assignment.parentSessionKey;
      while (parentSessionKey !== candidate["sessionKey"]) {
        ancestors.add(parentSessionKey);
        const parent = assignments.find(
          ({ sessionKey }) => sessionKey === parentSessionKey,
        );
        if (parent === undefined) return new Set(["__invalid__"]);
        parentSessionKey = parent.parentSessionKey;
      }
      return ancestors;
    };
    for (let left = 0; left < activeAssignments.length; left += 1) {
      const assignment = activeAssignments[left]!;
      for (let right = left + 1; right < activeAssignments.length; right += 1) {
        const other = activeAssignments[right]!;
        const list = candidate as unknown as TodoList;
        const assignmentSubtree = todoSubtreeIds(list, assignment.rootItemId);
        const otherSubtree = todoSubtreeIds(list, other.rootItemId);
        const overlaps = [...assignmentSubtree].some((id) =>
          otherSubtree.has(id),
        );
        if (!overlaps) continue;
        const assignmentAncestors = ancestorsFor(assignment);
        const otherAncestors = ancestorsFor(other);
        const assignmentIsDescendant = assignmentAncestors.has(
          other.sessionKey,
        );
        const otherIsDescendant = otherAncestors.has(assignment.sessionKey);
        if (!assignmentIsDescendant && !otherIsDescendant) return false;
        if (assignment.rootItemId === other.rootItemId) return false;
        if (
          assignmentIsDescendant &&
          !otherSubtree.has(assignment.rootItemId)
        ) {
          return false;
        }
        if (otherIsDescendant && !assignmentSubtree.has(other.rootItemId)) {
          return false;
        }
      }
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
  const items: TodoItem[] = template.items.map(({ id, parentId, text }) => {
    if (hasInvalidPlaceholderSyntax(text)) {
      throw new TypeError(
        `Todo template contains invalid placeholder syntax: ${input.templateId}`,
      );
    }
    const instantiated = instantiateText(text, input.taskContract);
    if (instantiated.trim() === "") {
      throw new TypeError(
        `Todo template produces empty item text: ${input.templateId}`,
      );
    }
    return {
      checked: false,
      id,
      ...(parentId === undefined ? {} : { parentId }),
      text: instantiated,
    };
  });
  if (!validTodoTree(items)) {
    throw new TypeError(
      `Todo template contains an invalid tree: ${input.templateId}`,
    );
  }
  return {
    items,
    sessionKey: input.sessionKey,
    stage: input.stage,
    template: input.templateId,
  };
};
