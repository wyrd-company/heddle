// ---
// relationships:
//   implements: heddle
// ---

import type { BoardTask } from "../board-adapter/index.js";
import { AttentionVisibleError } from "../attention-visible-error.js";
import { describeError } from "../error-details.js";
import type { PacingDeferral, PacingSession } from "../pacing/index.js";
import {
  createProductionErrorAttention,
  type ProductionErrorCode,
} from "../production/error-visibility.js";
import type {
  ReconcilerAttention,
  ReconcilerInstance,
  ReconcilerOptions,
  ReconciliationAction,
} from "./types.js";

const isEpic = (task: BoardTask): boolean => task.tags.includes("type:epic");
const isUat = (task: BoardTask): boolean => task.tags.includes("uat");
const byId = (left: BoardTask, right: BoardTask): number => left.id - right.id;
const epicAcceptanceAttentionId = (epicId: number): string =>
  `epic:${epicId}:acceptance:uat-child-missing`;
const epicDeliveryAttentionId = (epicId: number): string =>
  `epic:${epicId}:acceptance:delivery-child-incomplete`;
const epicUatTerminalAttentionId = (epicId: number): string =>
  `epic:${epicId}:acceptance:uat-terminal-unverified`;

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
    const instancesByTask = this.indexInstances(
      instances,
      new Set(orderedTasks.filter(isUat).map(({ id }) => id)),
    );
    const actions: ReconciliationAction[] = [];

    await this.mirrorInstanceStatuses(orderedTasks, instancesByTask, actions);
    if (
      this.options.epicOperations !== undefined &&
      this.options.dynamicTasks !== undefined
    ) {
      await this.reconcileCoordinatedEpics(orderedTasks, actions);
      const currentTasks = await this.options.board.readBoard();
      const standaloneTasks = currentTasks
        .filter(({ parent }) => parent === undefined)
        .sort(byId);
      const currentInstances = await this.options.instances.listInstances();
      await this.dispatchReadyTasks(
        standaloneTasks,
        new Map(standaloneTasks.map((task) => [task.id, task])),
        this.indexInstances(
          currentInstances,
          new Set(currentTasks.filter(isUat).map(({ id }) => id)),
        ),
        currentInstances,
        actions,
      );
      await this.raiseStaleAttention(currentInstances, actions);
    } else {
      await this.advanceEpics(orderedTasks, tasksById, actions);
      await this.promoteChildren(orderedTasks, tasksById, actions);
      await this.dispatchReadyTasks(
        orderedTasks,
        tasksById,
        instancesByTask,
        instances,
        actions,
      );
      await this.raiseStaleAttention(instances, actions);
    }

    return actions;
  }

  private async reconcileCoordinatedEpics(
    tasks: readonly BoardTask[],
    actions: ReconciliationAction[],
  ): Promise<void> {
    const epicIds = tasks.filter(isEpic).map(({ id }) => id);
    for (const epicId of epicIds) {
      await this.options.epicOperations!.run(epicId, async () => {
        await this.prepareEpicWithinBoundary(epicId, actions);
      });
      await this.options.epicOperations!.run(epicId, async () => {
        await this.dispatchEpicWithinBoundary(epicId, actions);
      });
      await this.options.epicOperations!.run(epicId, async () => {
        await this.completeEpicWithinBoundary(epicId, actions);
      });
    }
  }

  private async prepareEpicWithinBoundary(
    epicId: number,
    actions: ReconciliationAction[],
  ): Promise<void> {
    try {
      let tasks = await this.options.board.readBoard();
      let epic = tasks.find(({ id }) => id === epicId);
      if (epic === undefined || !isEpic(epic)) return;

      let children = tasks.filter(({ parent }) => parent === epicId);
      let deliveryChildren = children.filter((child) => !isUat(child));
      if (
        epic.status === "in-progress" &&
        deliveryChildren.length > 0 &&
        deliveryChildren.every(({ status }) => status === "done")
      ) {
        await this.transitionEpic(epic, "uat", actions);
      }

      tasks = await this.options.board.readBoard();
      epic = tasks.find(({ id }) => id === epicId);
      if (epic === undefined || !isEpic(epic)) return;
      children = tasks.filter(({ parent }) => parent === epicId);
      deliveryChildren = children.filter((child) => !isUat(child));
      const acceptanceChildren = children.filter(isUat);

      if (epic.status === "uat" && acceptanceChildren.length === 0) {
        await this.ensureConditionAttention(
          {
            attentionId: epicAcceptanceAttentionId(epic.id),
            code: "uat-child-missing",
            kind: "epic-acceptance",
            message: `Epic ${epic.id} requires a UAT child before acceptance`,
            taskId: epic.id,
          },
          actions,
        );
      } else {
        await this.resolveAttention(epicAcceptanceAttentionId(epic.id));
      }

      const incompleteDelivery = deliveryChildren.filter(
        ({ status }) => status !== "done",
      );
      const trustedDelivery = new Set<number>();
      const untrustedDelivery = new Set<number>();
      for (const child of incompleteDelivery) {
        try {
          if (this.options.dynamicTasks!.verifyTask(child) === undefined) {
            untrustedDelivery.add(child.id);
          } else {
            trustedDelivery.add(child.id);
          }
        } catch {
          untrustedDelivery.add(child.id);
        }
      }
      if (epic.status === "uat" && untrustedDelivery.size > 0) {
        await this.ensureConditionAttention(
          {
            attentionId: epicDeliveryAttentionId(epic.id),
            code: "uat-delivery-child-incomplete",
            kind: "epic-acceptance",
            message: `Epic ${epic.id} has incomplete delivery work without exact completed dynamic-task authority; move the epic to in-progress, remove it, or re-parent it`,
            taskId: epic.id,
          },
          actions,
        );
      } else {
        await this.resolveAttention(epicDeliveryAttentionId(epic.id));
      }

      const instances = await this.options.instances.listInstances();
      const uatState = this.uatState(acceptanceChildren, instances);
      if (epic.status === "uat" && uatState === "unverified") {
        await this.ensureConditionAttention(
          {
            attentionId: epicUatTerminalAttentionId(epic.id),
            code: "uat-terminal-unverified",
            kind: "epic-acceptance",
            message: `Epic ${epic.id} has a done UAT task without one retained terminal top-level runtime and no active delegated instances`,
            taskId: epic.id,
          },
          actions,
        );
      } else {
        await this.resolveAttention(epicUatTerminalAttentionId(epic.id));
      }

      const admissibleDuringUat =
        epic.status === "uat" && uatState === "verified"
          ? trustedDelivery
          : new Set<number>();
      const liveTasksById = new Map(tasks.map((task) => [task.id, task]));
      await this.promoteChildren(
        children,
        liveTasksById,
        actions,
        admissibleDuringUat,
      );
    } catch (error) {
      await this.raiseTaskError(
        epicId,
        "epic-status-transition-failed",
        `Epic ${epicId} reconciliation failed`,
        error,
        actions,
      );
    }
  }

  private async dispatchEpicWithinBoundary(
    epicId: number,
    actions: ReconciliationAction[],
  ): Promise<void> {
    try {
      const tasks = await this.options.board.readBoard();
      const epic = tasks.find(({ id }) => id === epicId);
      if (epic === undefined || !isEpic(epic)) return;
      const children = tasks.filter(({ parent }) => parent === epicId);
      const instances = await this.options.instances.listInstances();
      const acceptanceChildren = children.filter(isUat);
      const uatVerified =
        epic.status === "uat" &&
        this.uatState(acceptanceChildren, instances) === "verified";
      const admissibleDuringUat = new Set<number>();
      if (uatVerified) {
        for (const child of children.filter(
          (candidate) => !isUat(candidate) && candidate.status !== "done",
        )) {
          try {
            if (this.options.dynamicTasks!.verifyTask(child) !== undefined) {
              admissibleDuringUat.add(child.id);
            }
          } catch {
            // Authority attention is raised by the preparation decision. A
            // conflicting record remains inadmissible here.
          }
        }
      }
      await this.dispatchReadyTasks(
        children,
        new Map(tasks.map((task) => [task.id, task])),
        this.indexInstances(
          instances,
          new Set(acceptanceChildren.map(({ id }) => id)),
        ),
        instances,
        actions,
        admissibleDuringUat,
      );
    } catch (error) {
      await this.raiseTaskError(
        epicId,
        "epic-status-transition-failed",
        `Epic ${epicId} dispatch reconciliation failed`,
        error,
        actions,
      );
    }
  }

  private async completeEpicWithinBoundary(
    epicId: number,
    actions: ReconciliationAction[],
  ): Promise<void> {
    try {
      const tasks = await this.options.board.readBoard();
      const epic = tasks.find(({ id }) => id === epicId);
      if (epic === undefined || epic.status !== "uat") return;
      const children = tasks.filter(({ parent }) => parent === epicId);
      const acceptanceChildren = children.filter(isUat);
      const instances = await this.options.instances.listInstances();
      if (
        acceptanceChildren.length > 0 &&
        children.every(({ status }) => status === "done") &&
        this.uatState(acceptanceChildren, instances) === "verified" &&
        !this.options.dynamicTasks!.hasPendingForEpic(epicId)
      ) {
        await this.transitionEpic(epic, "done", actions);
      }
    } catch (error) {
      await this.raiseTaskError(
        epicId,
        "epic-status-transition-failed",
        `Epic ${epicId} completion reconciliation failed`,
        error,
        actions,
      );
    }
  }

  private uatState(
    acceptanceChildren: readonly BoardTask[],
    instances: readonly ReconcilerInstance[],
  ): "active" | "unverified" | "verified" {
    if (acceptanceChildren.length === 0) return "active";
    if (acceptanceChildren.some(({ status }) => status !== "done")) {
      return "active";
    }
    for (const child of acceptanceChildren) {
      const topLevel = instances.filter(
        (instance) =>
          instance.taskId === child.id &&
          instance.parentSessionId === undefined,
      );
      const delegatedActive = instances.some(
        (instance) =>
          instance.taskId === child.id &&
          instance.parentSessionId !== undefined &&
          instance.state !== "done",
      );
      if (
        topLevel.length !== 1 ||
        topLevel[0]!.state !== "done" ||
        topLevel[0]!.boardStatus !== "done" ||
        delegatedActive
      ) {
        return "unverified";
      }
    }
    return "verified";
  }

  private indexInstances(
    instances: readonly ReconcilerInstance[],
    toleratedDuplicateTaskIds: ReadonlySet<number> = new Set(),
  ): Map<number, ReconcilerInstance> {
    const indexed = new Map<number, ReconcilerInstance>();
    for (const instance of instances) {
      if (instance.parentSessionId !== undefined) continue;
      if (indexed.has(instance.taskId)) {
        // Retain one UAT record so an already-corrupt duplicate set cannot
        // trigger another dispatch. Terminal proof evaluates the complete set
        // and fails closed when the retained top-level count is not exact.
        if (toleratedDuplicateTaskIds.has(instance.taskId)) continue;
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
        instance.boardStatusMirrorBlocked === true ||
        task.status === instance.boardStatus
      ) {
        continue;
      }
      try {
        await this.transitionTask(task, instance.boardStatus, actions);
      } catch (error) {
        await this.raiseTaskError(
          task.id,
          "task-status-mirror-failed",
          `Task ${task.id} status mirroring failed`,
          error,
          actions,
          instance.instanceId,
        );
      }
    }
  }

  private async advanceEpics(
    tasks: readonly BoardTask[],
    tasksById: ReadonlyMap<number, BoardTask>,
    actions: ReconciliationAction[],
  ): Promise<void> {
    for (const epic of tasks.filter(isEpic)) {
      try {
        const children = tasks.filter(({ parent }) => parent === epic.id);
        const deliveryChildren = children.filter((child) => !isUat(child));
        if (
          epic.status === "in-progress" &&
          deliveryChildren.length > 0 &&
          deliveryChildren.every(
            ({ id }) => tasksById.get(id)?.status === "done",
          )
        ) {
          await this.transitionEpic(epic, "uat", actions);
        }

        if (
          epic.status === "uat" &&
          deliveryChildren.some(
            ({ id }) => tasksById.get(id)?.status !== "done",
          )
        ) {
          await this.ensureConditionAttention(
            {
              attentionId: epicDeliveryAttentionId(epic.id),
              code: "uat-delivery-child-incomplete",
              kind: "epic-acceptance",
              message: `Epic ${epic.id} has incomplete delivery children during UAT; move the epic to in-progress to admit them, or remove or re-parent them`,
              taskId: epic.id,
            },
            actions,
          );
        } else {
          await this.resolveAttention(epicDeliveryAttentionId(epic.id));
        }

        const acceptanceChildren = children.filter(isUat);
        if (epic.status === "uat" && acceptanceChildren.length === 0) {
          await this.ensureConditionAttention(
            {
              attentionId: epicAcceptanceAttentionId(epic.id),
              code: "uat-child-missing",
              kind: "epic-acceptance",
              message: `Epic ${epic.id} requires a UAT child before acceptance`,
              taskId: epic.id,
            },
            actions,
          );
          continue;
        }
        if (epic.status === "uat") {
          await this.resolveAttention(epicAcceptanceAttentionId(epic.id));
        }
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
      } catch (error) {
        await this.raiseTaskError(
          epic.id,
          "epic-status-transition-failed",
          `Epic ${epic.id} status transition failed`,
          error,
          actions,
        );
      }
    }
  }

  private async promoteChildren(
    tasks: readonly BoardTask[],
    tasksById: ReadonlyMap<number, BoardTask>,
    actions: ReconciliationAction[],
    admissibleDuringUat: ReadonlySet<number> = new Set(),
  ): Promise<void> {
    for (const child of tasks.filter(({ parent }) => parent !== undefined)) {
      if (child.status !== "backlog" || child.blocked) continue;
      const epic = tasksById.get(child.parent!);
      const shouldPromote =
        epic !== undefined &&
        isEpic(epic) &&
        ((epic.status === "in-progress" && !isUat(child)) ||
          (epic.status === "uat" &&
            (isUat(child) ||
              (admissibleDuringUat.has(child.id) &&
                this.dependenciesDone(child, tasksById)))));
      if (!shouldPromote) continue;
      try {
        await this.transitionTask(child, "todo", actions);
      } catch (error) {
        await this.raiseTaskError(
          child.id,
          "child-promotion-failed",
          `Task ${child.id} promotion failed`,
          error,
          actions,
        );
      }
    }
  }

  private async dispatchReadyTasks(
    tasks: readonly BoardTask[],
    tasksById: ReadonlyMap<number, BoardTask>,
    instances: ReadonlyMap<number, ReconcilerInstance>,
    instanceRecords: readonly ReconcilerInstance[],
    actions: ReconciliationAction[],
    admissibleDuringUat: ReadonlySet<number> = new Set(),
  ): Promise<void> {
    const activeSessions: PacingSession[] = instanceRecords
      .filter(
        ({ state }) =>
          state === "running" || state === "starting" || state === "waiting",
      )
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
        !this.dispatchEnabled(task, tasksById, admissibleDuringUat)
      ) {
        continue;
      }

      const instanceId = instanceIdForTask(task.id);
      try {
        const resolution = await this.options.lifecycleResolver.resolve(task);
        if (resolution.kind === "attention-required") {
          await this.raiseAttention(
            {
              ...(resolution.attention.artifactId === undefined
                ? {}
                : { artifactId: resolution.attention.artifactId }),
              attentionId: this.lifecycleAttentionId(
                task,
                resolution.attention,
              ),
              code: resolution.attention.code,
              kind: "lifecycle-resolution",
              message: resolution.attention.message,
              taskId: task.id,
            },
            actions,
          );
          continue;
        }

        let dispatch: { depth: 0; provider: string } | undefined;
        if (this.options.pacing !== undefined) {
          const provider =
            existing?.state === "starting" && existing.provider !== undefined
              ? existing.provider
              : this.options.pacing.providerFor === undefined
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
          ...(resolution.repositoryName === undefined
            ? {}
            : { repositoryName: resolution.repositoryName }),
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
          ...(resolution.repositoryName === undefined
            ? {}
            : { repositoryName: resolution.repositoryName }),
          taskId: task.id,
        });
      } catch (error) {
        if (error instanceof AttentionVisibleError) continue;
        await this.raiseTaskError(
          task.id,
          "task-reconciliation-failed",
          `Task ${task.id} reconciliation failed`,
          error,
          actions,
        );
      }
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
    admissibleDuringUat: ReadonlySet<number> = new Set(),
  ): boolean {
    if (task.parent === undefined) return true;
    const epic = tasks.get(task.parent);
    if (epic === undefined || !isEpic(epic)) return false;
    return isUat(task)
      ? epic.status === "uat"
      : epic.status === "in-progress" ||
          (epic.status === "uat" && admissibleDuringUat.has(task.id));
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
      try {
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
      } catch (error) {
        await this.raiseTaskError(
          instance.taskId,
          "stale-attention-failed",
          `Instance ${instance.instanceId} stale-attention evaluation failed`,
          error,
          actions,
          instance.instanceId,
        );
      }
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

  private async ensureConditionAttention(
    attention: ReconcilerAttention,
    actions: ReconciliationAction[],
  ): Promise<void> {
    if (!(await this.options.attention.has(attention.attentionId))) {
      await this.options.attention.raise(attention);
      actions.push({ attention, kind: "attention-raised" });
      return;
    }
    this.options.attention.reopen(attention.attentionId);
  }

  private async resolveAttention(attentionId: string): Promise<void> {
    if (!(await this.options.attention.has(attentionId))) return;
    this.options.attention.resolve(attentionId);
  }

  private async raiseTaskError(
    taskId: number,
    code: ProductionErrorCode,
    summary: string,
    error: unknown,
    actions: ReconciliationAction[],
    instanceId?: string,
  ): Promise<void> {
    await this.raiseAttention(
      createProductionErrorAttention({
        attentionId: `production:${code}:task:${taskId}${instanceId === undefined ? "" : `:${instanceId}`}`,
        code,
        error,
        ...(instanceId === undefined ? {} : { instanceId }),
        message: `${summary}: ${describeError(error)}`,
        taskId,
      }),
      actions,
    );
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
