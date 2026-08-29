// ---
// relationships:
//   implements: heddle
// ---

import type { BoardTask } from "../board-adapter/index.js";
import type { PacingDeferral, PacingSession } from "../pacing/index.js";
import type {
  ReconcilerAttention,
  ReconcilerInstance,
  ReconcilerOptions,
  ReconciliationAction,
} from "./types.js";

const isEpic = (task: BoardTask): boolean => task.tags.includes("type:epic");
const isUat = (task: BoardTask): boolean => task.tags.includes("uat");
const byId = (left: BoardTask, right: BoardTask): number => left.id - right.id;

const sameDeferral = (
  left: PacingDeferral | undefined,
  right: PacingDeferral,
): boolean => JSON.stringify(left) === JSON.stringify(right);

export const instanceIdForTask = (taskId: number): string => `task-${taskId}`;

export class Reconciler {
  private readonly now: () => number;
  private readonly staleThresholds: Readonly<Record<string, number>>;

  constructor(private readonly options: ReconcilerOptions) {
    this.now = options.now ?? Date.now;
    this.staleThresholds = options.staleThresholds ?? {};
  }

  async reconcile(): Promise<ReconciliationAction[]> {
    const [tasks, instances] = await Promise.all([
      this.options.board.readBoard(),
      this.options.instances.listInstances(),
    ]);
    const orderedTasks = [...tasks].sort(byId);
    const tasksById = new Map(orderedTasks.map((task) => [task.id, task]));
    const instancesByTask = this.indexInstances(instances);
    const actions: ReconciliationAction[] = [];

    await this.mirrorInstanceStatuses(orderedTasks, instancesByTask, actions);
    await this.advanceEpics(orderedTasks, tasksById, actions);
    await this.promoteChildren(orderedTasks, tasksById, actions);
    await this.dispatchReadyTasks(
      orderedTasks,
      tasksById,
      instancesByTask,
      actions,
    );
    await this.raiseStaleAttention(instances, actions);

    return actions;
  }

  private indexInstances(
    instances: readonly ReconcilerInstance[],
  ): Map<number, ReconcilerInstance> {
    const indexed = new Map<number, ReconcilerInstance>();
    for (const instance of instances) {
      if (indexed.has(instance.taskId)) {
        throw new Error(
          `More than one instance exists for task ${instance.taskId}`,
        );
      }
      indexed.set(instance.taskId, instance);
    }
    return indexed;
  }

  private async mirrorInstanceStatuses(
    tasks: readonly BoardTask[],
    instances: ReadonlyMap<number, ReconcilerInstance>,
    actions: ReconciliationAction[],
  ): Promise<void> {
    for (const task of tasks) {
      const instance = instances.get(task.id);
      if (
        isEpic(task) ||
        instance === undefined ||
        task.status === instance.boardStatus
      ) {
        continue;
      }
      await this.transitionTask(task, instance.boardStatus, actions);
    }
  }

  private async advanceEpics(
    tasks: readonly BoardTask[],
    tasksById: ReadonlyMap<number, BoardTask>,
    actions: ReconciliationAction[],
  ): Promise<void> {
    for (const epic of tasks.filter(isEpic)) {
      const children = tasks.filter(({ parent }) => parent === epic.id);
      const deliveryChildren = children.filter((child) => !isUat(child));
      if (
        epic.status === "in-progress" &&
        deliveryChildren.length > 0 &&
        deliveryChildren.every(({ id }) => tasksById.get(id)?.status === "done")
      ) {
        await this.transitionEpic(epic, "uat", actions);
      }

      const acceptanceChildren = children.filter(isUat);
      if (
        epic.status === "uat" &&
        deliveryChildren.every(
          ({ id }) => tasksById.get(id)?.status === "done",
        ) &&
        acceptanceChildren.length > 0 &&
        acceptanceChildren.every(
          ({ id }) => tasksById.get(id)?.status === "done",
        )
      ) {
        await this.transitionEpic(epic, "done", actions);
      }
    }
  }

  private async promoteChildren(
    tasks: readonly BoardTask[],
    tasksById: ReadonlyMap<number, BoardTask>,
    actions: ReconciliationAction[],
  ): Promise<void> {
    for (const child of tasks.filter(({ parent }) => parent !== undefined)) {
      if (child.status !== "backlog" || child.blocked) continue;
      const epic = tasksById.get(child.parent!);
      const shouldPromote =
        epic !== undefined &&
        isEpic(epic) &&
        ((epic.status === "in-progress" && !isUat(child)) ||
          (epic.status === "uat" && isUat(child)));
      if (shouldPromote) await this.transitionTask(child, "todo", actions);
    }
  }

  private async dispatchReadyTasks(
    tasks: readonly BoardTask[],
    tasksById: ReadonlyMap<number, BoardTask>,
    instances: ReadonlyMap<number, ReconcilerInstance>,
    actions: ReconciliationAction[],
  ): Promise<void> {
    const activeSessions: PacingSession[] = [...instances.values()]
      .filter(({ state }) => state === "running" || state === "waiting")
      .map((instance) => ({
        depth: instance.depth ?? 0,
        sessionId: instance.instanceId,
        ...(instance.parentSessionId === undefined
          ? {}
          : { parentSessionId: instance.parentSessionId }),
        ...(instance.provider === undefined
          ? {}
          : { provider: instance.provider }),
      }));

    for (const task of tasks) {
      const existing = instances.get(task.id);
      if (
        isEpic(task) ||
        task.blocked ||
        task.status !== "todo" ||
        (existing !== undefined &&
          existing.state !== "deferred" &&
          existing.state !== "starting") ||
        !this.dependenciesDone(task, tasksById) ||
        !this.dispatchEnabled(task, tasksById)
      ) {
        continue;
      }

      const resolution = await this.options.lifecycleResolver.resolve(task);
      if (resolution.kind === "attention-required") {
        await this.raiseAttention(
          {
            ...(resolution.attention.artifactId === undefined
              ? {}
              : { artifactId: resolution.attention.artifactId }),
            attentionId: this.lifecycleAttentionId(task, resolution.attention),
            code: resolution.attention.code,
            kind: "lifecycle-resolution",
            message: resolution.attention.message,
            taskId: task.id,
          },
          actions,
        );
        continue;
      }

      const instanceId = instanceIdForTask(task.id);
      let dispatch: { depth: 0; provider: string } | undefined;
      if (this.options.pacing !== undefined) {
        const provider =
          this.options.pacing.providerFor === undefined
            ? this.options.pacing.evaluator.defaultProvider
            : await this.options.pacing.providerFor(task, resolution);
        const decision = await this.options.pacing.evaluator.evaluate(
          { kind: "task", provider, sessionId: instanceId },
          activeSessions,
        );
        if (decision.kind === "defer") {
          if (!sameDeferral(existing?.deferral, decision.deferral)) {
            await this.options.instances.defer({
              boardStatus: task.status,
              deferral: decision.deferral,
              depth: 0,
              instanceId,
              provider,
              taskId: task.id,
            });
            actions.push({
              deferral: decision.deferral,
              instanceId,
              kind: "dispatch-deferred",
              provider,
              taskId: task.id,
            });
          }
          continue;
        }
        dispatch = { depth: 0, provider };
      }

      await this.options.instances.start({
        blueprintPath: resolution.blueprintPath,
        ...(dispatch === undefined ? {} : { dispatch }),
        instanceId,
        task: { ...task },
      });
      if (dispatch !== undefined) {
        activeSessions.push({
          depth: dispatch.depth,
          provider: dispatch.provider,
          sessionId: instanceId,
        });
      }
      actions.push({
        blueprintPath: resolution.blueprintPath,
        instanceId,
        kind: "instance-start",
        taskId: task.id,
      });
    }
  }

  private dependenciesDone(
    task: BoardTask,
    tasks: ReadonlyMap<number, BoardTask>,
  ): boolean {
    return task.dependencies.every((dependencyId) => {
      const dependency = tasks.get(dependencyId);
      return dependency === undefined || dependency.status === "done";
    });
  }

  private dispatchEnabled(
    task: BoardTask,
    tasks: ReadonlyMap<number, BoardTask>,
  ): boolean {
    if (task.parent === undefined) return true;
    const epic = tasks.get(task.parent);
    if (epic === undefined || !isEpic(epic)) return false;
    return isUat(task) ? epic.status === "uat" : epic.status === "in-progress";
  }

  private async raiseStaleAttention(
    instances: readonly ReconcilerInstance[],
    actions: ReconciliationAction[],
  ): Promise<void> {
    const now = this.now();
    for (const instance of instances) {
      if (
        instance.state === "done" ||
        instance.stageId === undefined ||
        instance.stageEnteredAt === undefined
      ) {
        continue;
      }
      const threshold = this.staleThresholds[instance.stageId];
      if (
        threshold === undefined ||
        now - instance.stageEnteredAt <= threshold
      ) {
        continue;
      }
      await this.raiseAttention(
        {
          attentionId: [
            "instance",
            instance.instanceId,
            "stale",
            instance.stageId,
            String(instance.stageEnteredAt),
          ].join(":"),
          code: "stage-stale",
          instanceId: instance.instanceId,
          kind: "stale-instance",
          message: `Instance ${instance.instanceId} exceeded the ${instance.stageId} stage threshold`,
          taskId: instance.taskId,
        },
        actions,
      );
    }
  }

  private lifecycleAttentionId(
    task: BoardTask,
    attention: { artifactId?: string; code: string },
  ): string {
    return [
      "task",
      String(task.id),
      "lifecycle",
      attention.code,
      attention.artifactId ?? "undeclared",
    ].join(":");
  }

  private async raiseAttention(
    attention: ReconcilerAttention,
    actions: ReconciliationAction[],
  ): Promise<void> {
    if (await this.options.attention.has(attention.attentionId)) return;
    await this.options.attention.raise(attention);
    actions.push({ attention, kind: "attention-raised" });
  }

  private async transitionTask(
    task: BoardTask,
    status: string,
    actions: ReconciliationAction[],
  ): Promise<void> {
    const from = task.status;
    await this.options.board.mirrorTaskStatus(task.id, status);
    task.status = status;
    actions.push({
      from,
      kind: "task-status-transition",
      taskId: task.id,
      to: status,
    });
  }

  private async transitionEpic(
    epic: BoardTask,
    status: "done" | "uat",
    actions: ReconciliationAction[],
  ): Promise<void> {
    const from = epic.status;
    await this.options.board.transitionEpicStatus(epic.id, status);
    epic.status = status;
    actions.push({
      from,
      kind: "epic-status-transition",
      taskId: epic.id,
      to: status,
    });
  }
}
