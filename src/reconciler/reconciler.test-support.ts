// ---
// relationships:
//   implements: heddle
// ---

import type { BoardTask } from "../board-adapter/index.js";
import {
  Reconciler,
  type ReconcilerAttention,
  type ReconcilerBoard,
  type ReconcilerInstance,
  type ReconcilerInstanceController,
  type ReconcilerLifecycleResolver,
  type ReconcilerOptions,
  type ReconcilerPacing,
  type StartReconcilerInstanceInput,
} from "./index.js";

export const task = (
  id: number,
  status: string,
  overrides: Partial<BoardTask> = {},
): BoardTask => ({
  blocked: false,
  dependencies: [],
  id,
  priority: "medium",
  status,
  tags: [],
  title: `Sample record ${id}`,
  ...overrides,
});

class FixtureBoard implements ReconcilerBoard {
  readonly statusWrites: Array<{ status: string; taskId: number }> = [];
  readonly epicWrites: Array<{ status: "done" | "uat"; taskId: number }> = [];

  constructor(readonly tasks: BoardTask[]) {}

  async readBoard(): Promise<BoardTask[]> {
    return this.tasks.map((item) => ({ ...item }));
  }

  async mirrorTaskStatus(taskId: number, status: string): Promise<void> {
    const item = this.required(taskId);
    if (item.tags.includes("type:epic")) {
      throw new Error("fixture cannot mirror an epic");
    }
    item.status = status;
    this.statusWrites.push({ status, taskId });
  }

  async transitionEpicStatus(
    taskId: number,
    status: "done" | "uat",
  ): Promise<void> {
    this.required(taskId).status = status;
    this.epicWrites.push({ status, taskId });
  }

  private required(taskId: number): BoardTask {
    const item = this.tasks.find(({ id }) => id === taskId);
    if (item === undefined) throw new Error(`fixture task ${taskId} is absent`);
    return item;
  }
}

class FixtureInstances implements ReconcilerInstanceController {
  readonly deferrals: ReconcilerInstance[] = [];
  readonly instances: ReconcilerInstance[] = [];
  readonly starts: StartReconcilerInstanceInput[] = [];

  constructor(private readonly failingStartTaskId?: number) {}

  async listInstances(): Promise<ReconcilerInstance[]> {
    return this.instances.map((instance) => ({ ...instance }));
  }

  async defer(
    input: Parameters<ReconcilerInstanceController["defer"]>[0],
  ): Promise<void> {
    const deferred: ReconcilerInstance = {
      ...input,
      state: "deferred",
    };
    this.deferrals.push(deferred);
    this.replace(deferred);
  }

  async start(input: StartReconcilerInstanceInput): Promise<void> {
    if (input.task.id === this.failingStartTaskId) {
      throw new Error(`Injected start failure for task ${input.task.id}`);
    }
    this.starts.push(input);
    this.replace({
      boardStatus: input.task.status,
      ...(input.dispatch ?? {}),
      instanceId: input.instanceId,
      state: "waiting",
      taskId: input.task.id,
    });
  }

  private replace(instance: ReconcilerInstance): void {
    const index = this.instances.findIndex(
      ({ taskId }) => taskId === instance.taskId,
    );
    if (index === -1) this.instances.push(instance);
    else this.instances[index] = instance;
  }
}

class FixtureAttentionQueue {
  readonly entries = new Map<string, ReconcilerAttention>();
  readonly records = new Map<string, ReconcilerAttention>();
  readonly reopenings: string[] = [];
  readonly resolutions: string[] = [];

  async has(attentionId: string): Promise<boolean> {
    return this.records.has(attentionId);
  }

  async raise(attention: ReconcilerAttention): Promise<void> {
    this.records.set(attention.attentionId, attention);
    this.entries.set(attention.attentionId, attention);
  }

  reopen(attentionId: string): boolean {
    const attention = this.records.get(attentionId);
    if (attention === undefined) {
      throw new Error(`Fixture attention ${attentionId} does not exist`);
    }
    if (this.entries.has(attentionId)) return false;
    this.entries.set(attentionId, attention);
    this.reopenings.push(attentionId);
    return true;
  }

  resolve(attentionId: string): boolean {
    if (!this.records.has(attentionId)) {
      throw new Error(`Fixture attention ${attentionId} does not exist`);
    }
    if (!this.entries.delete(attentionId)) return false;
    this.resolutions.push(attentionId);
    return true;
  }
}

const lifecycleResolver: ReconcilerLifecycleResolver = {
  resolve: async (item) =>
    item.lifecycle === undefined
      ? {
          attention: {
            code: "lifecycle-not-declared",
            message: `Task ${item.id} does not declare a lifecycle`,
            taskId: item.id,
          },
          kind: "attention-required",
        }
      : {
          artifactId: item.lifecycle,
          blueprintPath: `blueprints/${item.lifecycle}.json`,
          kind: "resolved",
        },
};

export const fixture = (
  tasks: BoardTask[],
  options: {
    coordinated?: boolean;
    epicOperations?: ReconcilerOptions["epicOperations"];
    failingStartTaskId?: number;
    now?: () => number;
    pacing?: ReconcilerPacing;
    pendingEpicIds?: readonly number[];
    staleThresholds?: Record<string, number>;
    trustedTaskIds?: readonly number[];
  } = {},
) => {
  const board = new FixtureBoard(tasks);
  const instances = new FixtureInstances(options.failingStartTaskId);
  const attention = new FixtureAttentionQueue();
  const trustedTaskIds = new Set(options.trustedTaskIds ?? []);
  const pendingEpicIds = new Set(options.pendingEpicIds ?? []);
  const reconciler = new Reconciler({
    attention,
    board,
    ...(options.coordinated
      ? {
          dynamicTasks: {
            hasPendingForEpic: (epicId: number) => pendingEpicIds.has(epicId),
            verifyTask: (item: BoardTask) =>
              trustedTaskIds.has(item.id) ? { taskId: item.id } : undefined,
          },
          epicOperations: options.epicOperations ?? {
            run: <T>(_epicId: number, operation: () => Promise<T>) =>
              operation(),
          },
        }
      : {}),
    instances,
    lifecycleResolver,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.pacing === undefined ? {} : { pacing: options.pacing }),
    ...(options.staleThresholds === undefined
      ? {}
      : { staleThresholds: options.staleThresholds }),
  });
  return { attention, board, instances, reconciler };
};
