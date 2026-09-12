// ---
// relationships:
//   implements: heddle
// ---

import type { BoardTask } from "../board-adapter/index.js";
import { type ConsoleScope, projectTasksForScope } from "./projection.js";
import type { ConsoleAttention, ConsoleInstance } from "./types.js";

export type DependencyNodeTreatment =
  "attention" | "blocked" | "done" | "idle" | "running";

export type DependencyGraphAttention = Pick<
  ConsoleAttention,
  "attentionId" | "instanceId" | "taskId"
>;

export interface DependencyGraphNode {
  id: number;
  layer: number;
  priority: string;
  row: number;
  status: string;
  title: string;
  treatment: DependencyNodeTreatment;
}

export interface DependencyGraphEdge {
  from: number;
  to: number;
  trace: boolean;
}

export interface DependencyGraphProjection {
  edges: DependencyGraphEdge[];
  nodes: DependencyGraphNode[];
  scope: ConsoleScope;
}

const uniqueTasks = (tasks: BoardTask[]): Map<number, BoardTask> => {
  const result = new Map<number, BoardTask>();
  for (const task of tasks) {
    if (result.has(task.id)) {
      throw new Error(`more than one board task exists with id ${task.id}`);
    }
    result.set(task.id, task);
  }
  return result;
};

const instanceTasks = (instances: ConsoleInstance[]): Map<string, number> => {
  const result = new Map<string, number>();
  for (const instance of instances) {
    const prior = result.get(instance.instanceId);
    if (prior !== undefined && prior !== instance.taskId) {
      throw new Error(
        `instance ${instance.instanceId} names more than one task`,
      );
    }
    result.set(instance.instanceId, instance.taskId);
  }
  return result;
};

const attentionTasks = (
  attention: DependencyGraphAttention[],
  byInstance: Map<string, number>,
): Set<number> => {
  const result = new Set<number>();
  for (const item of attention) {
    const instanceTask =
      item.instanceId === undefined
        ? undefined
        : byInstance.get(item.instanceId);
    if (
      item.taskId !== undefined &&
      instanceTask !== undefined &&
      item.taskId !== instanceTask
    ) {
      throw new Error(
        `attention ${item.attentionId} disagrees about its task identity`,
      );
    }
    const taskId = item.taskId ?? instanceTask;
    if (taskId !== undefined) result.add(taskId);
  }
  return result;
};

export const projectDependencyGraphAttention = (
  attention: ConsoleAttention,
): DependencyGraphAttention => ({
  attentionId: attention.attentionId,
  ...(attention.instanceId === undefined
    ? {}
    : { instanceId: attention.instanceId }),
  ...(attention.taskId === undefined ? {} : { taskId: attention.taskId }),
});

const treatmentFor = (
  task: BoardTask,
  allTasks: Map<number, BoardTask>,
  awaitingAttention: Set<number>,
  runningTasks: Set<number>,
): DependencyNodeTreatment => {
  if (awaitingAttention.has(task.id)) return "attention";
  if (task.status === "done") return "done";
  if (
    task.blocked ||
    task.dependencies.some((dependencyId) => {
      const dependency = allTasks.get(dependencyId);
      return dependency !== undefined && dependency.status !== "done";
    })
  ) {
    return "blocked";
  }
  return runningTasks.has(task.id) ? "running" : "idle";
};

const layersFor = (
  tasks: BoardTask[],
  visibleIds: Set<number>,
): Map<number, number> => {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const result = new Map<number, number>();
  const visiting = new Set<number>();

  const visit = (taskId: number): number => {
    const prior = result.get(taskId);
    if (prior !== undefined) return prior;
    if (visiting.has(taskId)) {
      throw new Error("dependency graph contains a cycle");
    }
    visiting.add(taskId);
    const task = byId.get(taskId)!;
    const dependencies = task.dependencies.filter((id) => visibleIds.has(id));
    const layer =
      dependencies.length === 0
        ? 0
        : Math.max(...dependencies.map((id) => visit(id))) + 1;
    visiting.delete(taskId);
    result.set(taskId, layer);
    return layer;
  };

  for (const task of tasks) visit(task.id);
  return result;
};

export const buildDependencyGraphProjection = (input: {
  attention: DependencyGraphAttention[];
  instances: ConsoleInstance[];
  scope: ConsoleScope;
  tasks: BoardTask[];
}): DependencyGraphProjection => {
  const allTasks = uniqueTasks(input.tasks);
  const tasks = projectTasksForScope(input.tasks, input.scope);
  const visibleIds = new Set(tasks.map(({ id }) => id));
  const tasksByInstance = instanceTasks(input.instances);
  const awaitingAttention = attentionTasks(input.attention, tasksByInstance);
  const runningTasks = new Set(tasksByInstance.values());
  const layers = layersFor(tasks, visibleIds);
  const rowByLayer = new Map<number, number>();

  const nodes = [...tasks]
    .sort((left, right) => left.id - right.id)
    .map((task): DependencyGraphNode => {
      const layer = layers.get(task.id)!;
      const row = rowByLayer.get(layer) ?? 0;
      rowByLayer.set(layer, row + 1);
      return {
        id: task.id,
        layer,
        priority: task.priority,
        row,
        status: task.status,
        title: task.title,
        treatment: treatmentFor(
          task,
          allTasks,
          awaitingAttention,
          runningTasks,
        ),
      };
    });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges = tasks
    .flatMap((task) =>
      [...new Set(task.dependencies)]
        .filter((dependencyId) => visibleIds.has(dependencyId))
        .map((dependencyId): DependencyGraphEdge => {
          const from = nodeById.get(dependencyId)!;
          const to = nodeById.get(task.id)!;
          return {
            from: dependencyId,
            to: task.id,
            trace:
              to.treatment === "blocked" &&
              (from.treatment === "attention" || from.treatment === "blocked"),
          };
        }),
    )
    .sort((left, right) => left.to - right.to || left.from - right.from);

  return { edges, nodes, scope: input.scope };
};
