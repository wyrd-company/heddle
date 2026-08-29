// ---
// relationships:
//   implements: heddle
// ---

import type { BoardTask } from "../board-adapter/index.js";
import type { ConsoleInstance } from "./types.js";

export type ConsoleScope =
  | { kind: "all" }
  | { epicId: number; kind: "epic" }
  | { kind: "task"; taskId: number };

export interface ProjectedTask extends BoardTask {
  dwellMilliseconds?: number;
  instanceId?: string;
  stageEnteredAt?: number;
  stageId?: string;
}

export interface KanbanProjection {
  columns: Array<{
    status: string;
    tasks: ProjectedTask[];
  }>;
  scope: ConsoleScope;
}

const scopedId = /^(epic|task):([1-9][0-9]*)$/;

export const parseConsoleScope = (value: string | null): ConsoleScope => {
  if (value === null || value === "" || value === "all") {
    return { kind: "all" };
  }
  const match = scopedId.exec(value);
  if (match === null) {
    throw new Error("scope must be all, epic:<id>, or task:<id>");
  }
  const id = Number(match[2]);
  if (!Number.isSafeInteger(id)) {
    throw new Error("scope id must be a safe integer");
  }
  return match[1] === "epic"
    ? { epicId: id, kind: "epic" }
    : { kind: "task", taskId: id };
};

export const serializeConsoleScope = (scope: ConsoleScope): string => {
  switch (scope.kind) {
    case "all":
      return "all";
    case "epic":
      return `epic:${scope.epicId}`;
    case "task":
      return `task:${scope.taskId}`;
  }
};

const tasksInScope = (tasks: BoardTask[], scope: ConsoleScope): BoardTask[] => {
  switch (scope.kind) {
    case "all":
      return tasks;
    case "epic":
      return tasks.filter(
        ({ id, parent }) => id === scope.epicId || parent === scope.epicId,
      );
    case "task":
      return tasks.filter(({ id }) => id === scope.taskId);
  }
};

const instancesByTask = (
  instances: ConsoleInstance[],
): Map<number, ConsoleInstance> => {
  const result = new Map<number, ConsoleInstance>();
  for (const instance of instances) {
    if (result.has(instance.taskId)) {
      throw new Error(
        `more than one instance exists for task ${instance.taskId}`,
      );
    }
    result.set(instance.taskId, instance);
  }
  return result;
};

const enrich = (
  task: BoardTask,
  instance: ConsoleInstance | undefined,
  now: number,
): ProjectedTask => {
  if (task.status !== "in-progress" || instance === undefined) return task;
  return {
    ...task,
    instanceId: instance.instanceId,
    ...(instance.stageId === undefined ? {} : { stageId: instance.stageId }),
    ...(instance.stageEnteredAt === undefined
      ? {}
      : {
          dwellMilliseconds: Math.max(0, now - instance.stageEnteredAt),
          stageEnteredAt: instance.stageEnteredAt,
        }),
  };
};

export const buildKanbanProjection = (input: {
  instances: ConsoleInstance[];
  now: number;
  scope: ConsoleScope;
  statuses: string[];
  tasks: BoardTask[];
}): KanbanProjection => {
  const statusSet = new Set(input.statuses);
  const unknown = input.tasks.find(({ status }) => !statusSet.has(status));
  if (unknown !== undefined) {
    throw new Error(
      `task ${unknown.id} uses unconfigured board status ${JSON.stringify(unknown.status)}`,
    );
  }
  const instanceIndex = instancesByTask(input.instances);
  const tasks = tasksInScope(input.tasks, input.scope);
  return {
    columns: input.statuses.map((status) => ({
      status,
      tasks: tasks
        .filter((task) => task.status === status)
        .map((task) => enrich(task, instanceIndex.get(task.id), input.now)),
    })),
    scope: input.scope,
  };
};
