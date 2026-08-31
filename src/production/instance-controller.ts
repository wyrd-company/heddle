// ---
// relationships:
//   implements: heddle
// ---

import { createHash } from "node:crypto";

import type { BoardTask } from "../board-adapter/index.js";
import { AttentionVisibleError } from "../attention-visible-error.js";
import { describeError, errorDetail } from "../error-details.js";
import {
  bootstrapStageSession,
  HandoffRenderError,
  HandoffTemplateError,
  mechanicalChangeContextKey,
  mechanicalBoardStatusNames,
  type MechanicalBoardStatuses,
  type SessionT3Client,
  type SessionTemplateAuthority,
  type SystemPromptResolver,
} from "../control-plane/index.js";
import {
  readLifecycleContext,
  UnexpectedLandingError,
  type LifecycleContextRecord,
  type LifecycleSnapshot,
} from "../engine/index.js";
import type { PacingDeferral } from "../pacing/index.js";
import type {
  JsonValue,
  ReconcilerRuntimeRecord,
  SqlitePersistence,
} from "../persistence/index.js";
import type {
  DeferReconcilerInstanceInput,
  ReconcilerInstance,
  ReconcilerAttentionQueue,
  ReconcilerInstanceController,
  StartReconcilerInstanceInput,
} from "../reconciler/index.js";
import { isTodoState } from "../todo/index.js";
import type { ProductionConfiguration } from "./configuration.js";
import { heddleSessionTitle } from "./session-title.js";
import { readProductionHandoffStage } from "./stage-handoff.js";
import type { EpicProjectCoordinator } from "./epic-projects.js";
import type { ProductionLifecycleRouter } from "./lifecycle-router.js";
import {
  TaskRoutingAttentionError,
  type ProductRoutingCatalog,
} from "./product-routing.js";

const json = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value)) as JsonValue;

const taskContract = (task: BoardTask): JsonValue => {
  const contract = { ...task } as Partial<BoardTask>;
  delete contract.frontMatter;
  return json(contract);
};

const stableUuid = (seed: string): string => {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
};

const deferral = (value: JsonValue | undefined): PacingDeferral | undefined =>
  value as PacingDeferral | undefined;

const defaultMechanicalBoardStatuses =
  async (): Promise<MechanicalBoardStatuses> => ({
    ...mechanicalBoardStatusNames,
  });

export class ProductionInstanceController implements ReconcilerInstanceController {
  public constructor(
    private readonly configuration: ProductionConfiguration,
    private readonly persistence: SqlitePersistence,
    private readonly lifecycle: ProductionLifecycleRouter,
    private readonly routing: ProductRoutingCatalog,
    private readonly projects: EpicProjectCoordinator,
    private readonly attention: ReconcilerAttentionQueue,
    private readonly t3: SessionT3Client,
    private readonly resolveSystemPrompt: SystemPromptResolver,
    private readonly templateAuthority: SessionTemplateAuthority,
    private readonly boardStatuses: () => Promise<MechanicalBoardStatuses> = defaultMechanicalBoardStatuses,
    private readonly mirrorBoardStatus: (
      taskId: number,
      status: string,
    ) => Promise<void> = async () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  async listInstances(): Promise<ReconcilerInstance[]> {
    const runtimes = this.persistence.listReconcilerRuntime();
    const runtimeByInstanceId = new Map(
      runtimes.map((runtime) => [runtime.instanceId, runtime]),
    );
    const topLevel = runtimes.map((runtime) => ({
      boardStatus: runtime.boardStatus,
      ...(runtime.deferral === undefined
        ? {}
        : { deferral: deferral(runtime.deferral) }),
      depth: 0,
      instanceId: runtime.instanceId,
      ...(runtime.provider === undefined ? {} : { provider: runtime.provider }),
      ...(runtime.stageEnteredAt === undefined
        ? {}
        : { stageEnteredAt: runtime.stageEnteredAt }),
      ...(runtime.stageId === undefined ? {} : { stageId: runtime.stageId }),
      state: runtime.state,
      taskId: runtime.taskId,
    }));
    const delegated = this.persistence.listInstances().flatMap((instance) => {
      const runtime = runtimeByInstanceId.get(instance.instanceId);
      if (runtime === undefined || !isTodoState(instance.state.todoState)) {
        return [];
      }
      return instance.state.todoState.lists.flatMap((list) =>
        (list.assignments ?? [])
          .filter(({ status }) => status === "active")
          .map((assignment) => ({
            boardStatus: runtime.boardStatus,
            depth: assignment.depth,
            instanceId: assignment.sessionKey,
            parentSessionId: assignment.parentSessionKey,
            provider: assignment.provider,
            state: "waiting" as const,
            taskId: runtime.taskId,
          })),
      );
    });
    return [...topLevel, ...delegated];
  }

  async defer(input: DeferReconcilerInstanceInput): Promise<void> {
    const previous = this.persistence
      .listReconcilerRuntime()
      .find(({ instanceId }) => instanceId === input.instanceId);
    this.persistence.writeReconcilerRuntime({
      ...(previous?.state === "starting" ? previous : {}),
      boardStatus: input.boardStatus,
      deferral: json(input.deferral),
      instanceId: input.instanceId,
      provider: input.provider,
      state: "deferred",
      taskId: input.taskId,
    });
  }

  async start(input: StartReconcilerInstanceInput): Promise<void> {
    const previous = this.persistence
      .listReconcilerRuntime()
      .find(({ instanceId }) => instanceId === input.instanceId);
    const provider = input.dispatch?.provider ?? previous?.provider;
    const starting: ReconcilerRuntimeRecord = {
      ...(previous?.state === "starting" ? previous : {}),
      boardStatus: input.task.status,
      instanceId: input.instanceId,
      ...(provider === undefined ? {} : { provider }),
      state: "starting",
      taskId: input.task.id,
    };
    this.persistence.writeReconcilerRuntime(starting);

    const existing = this.persistence.getInstance(input.instanceId);
    const existingContext =
      existing === undefined ? undefined : readLifecycleContext(existing);
    const snapshot =
      existing === undefined ||
      existingContext?.pendingTransition?.kind === "start"
        ? await this.lifecycle
            .start({
              blueprintPath: input.blueprintPath,
              ...(existing === undefined
                ? {
                    initialContext: {
                      ...this.#mechanicalChange(
                        input.task,
                        input.repositoryName,
                      ),
                      taskContract: taskContract(input.task),
                      taskId: input.task.id,
                    },
                  }
                : {}),
              instanceId: input.instanceId,
            })
            .catch((error: unknown) => {
              if (error instanceof UnexpectedLandingError) {
                throw new AttentionVisibleError(error);
              }
              throw error;
            })
        : existingContext;
    if (snapshot === undefined) {
      throw new Error(`Instance ${input.instanceId} recovery state is absent`);
    }
    const stageId = snapshot.awaitingNodeIds[0];
    if (stageId === undefined) {
      this.persistence.writeReconcilerRuntime({
        ...starting,
        boardStatus: snapshot.status === "completed" ? "done" : "in-progress",
        state: snapshot.status === "completed" ? "done" : "running",
      });
      return;
    }
    await this.#activate(
      input.task,
      input.instanceId,
      stageId,
      starting,
      existing === undefined
        ? (await this.boardStatuses()).inProgress
        : starting.boardStatus,
    );
  }

  #mechanicalChange(
    task: BoardTask,
    repositoryName?: string,
  ): Record<string, JsonValue> {
    const repository = (() => {
      try {
        return this.routing.repositoryForStage(task, repositoryName);
      } catch (error) {
        if (error instanceof TaskRoutingAttentionError) return undefined;
        throw error;
      }
    })();
    if (repository === undefined) return {};
    const session = this.configuration.session;
    return {
      [mechanicalChangeContextKey]: json({
        baseBranch:
          task.parent === undefined ? session.baseRef : `epic/${task.parent}`,
        branch: `heddle/task-${task.id}`,
        repositoryName: repository.name,
        repositoryRoot: repository.repositoryRoot,
        reviewDescription: `Task ${task.id}: ${task.title}`,
        reviewTitle: task.title,
        taskId: task.id,
        worktreeName: String(task.id),
        ...(session.worktreesRoot === undefined
          ? {}
          : { worktreesRoot: session.worktreesRoot }),
      }),
    };
  }

  async synchronize(tasks: readonly BoardTask[]): Promise<void> {
    const tasksById = new Map(tasks.map((task) => [task.id, task]));
    for (const runtime of this.persistence.listReconcilerRuntime()) {
      if (
        await this.attention.has(
          `production:task-reconciliation-failed:task:${runtime.taskId}`,
        )
      ) {
        continue;
      }
      try {
        const record = this.persistence.getInstance(runtime.instanceId);
        if (record === undefined) {
          await this.#raiseSynchronizationError(
            runtime,
            "lifecycle-instance-absent",
            new Error(
              `Instance ${runtime.instanceId} has runtime state but no lifecycle state`,
            ),
          );
          continue;
        }
        const task = tasksById.get(runtime.taskId);
        if (task === undefined) {
          await this.#raiseSynchronizationError(
            runtime,
            "board-task-absent",
            new Error(
              `Task ${runtime.taskId} is absent during lifecycle synchronization`,
            ),
          );
          continue;
        }
        const context = readLifecycleContext(record);
        if (context.pendingTransition !== null) {
          if (this.lifecycle.isTransitionActive(runtime.instanceId)) continue;
          const snapshot = await this.#replayPendingTransition(
            runtime.instanceId,
            context,
          ).catch((error: unknown) => {
            if (error instanceof UnexpectedLandingError) {
              throw new AttentionVisibleError(error);
            }
            throw error;
          });
          await this.#synchronizeSnapshot(task, runtime, snapshot);
          continue;
        }
        await this.#synchronizeSnapshot(task, runtime, context);
      } catch (error) {
        if (error instanceof AttentionVisibleError) continue;
        await this.#raiseSynchronizationError(
          runtime,
          "instance-synchronization-failed",
          error,
        );
      }
    }
  }

  async #replayPendingTransition(
    instanceId: string,
    context: LifecycleContextRecord,
  ): Promise<LifecycleSnapshot> {
    const pending = context.pendingTransition;
    if (pending === null) {
      throw new Error(`Instance ${instanceId} has no pending transition`);
    }
    if (pending.kind === "start") {
      return this.lifecycle.start({
        blueprintPath: context.blueprintPath,
        instanceId,
      });
    }
    if (pending.disposition === null || pending.operationId === null) {
      throw new Error(
        `Instance ${instanceId} pending resume transition is incomplete`,
      );
    }
    return this.lifecycle.resume({
      disposition: pending.disposition,
      instanceId,
      operationId: pending.operationId,
      ...(pending.output === null ? {} : { output: pending.output }),
    });
  }

  async #synchronizeSnapshot(
    task: BoardTask,
    runtime: ReconcilerRuntimeRecord,
    snapshot: Pick<LifecycleContextRecord, "awaitingNodeIds" | "status">,
  ): Promise<void> {
    const stageId = snapshot.awaitingNodeIds[0];
    if (stageId === undefined) {
      this.persistence.writeReconcilerRuntime({
        ...runtime,
        boardStatus:
          snapshot.status === "completed"
            ? (await this.boardStatuses()).completed
            : runtime.boardStatus,
        state: snapshot.status === "completed" ? "done" : "running",
      });
      return;
    }
    const sameStage = runtime.stageId === stageId;
    if (sameStage && runtime.state === "waiting") return;
    const restoreInitialBoardStatus =
      runtime.state === "starting" && task.status === "todo";
    const starting: ReconcilerRuntimeRecord = {
      ...runtime,
      boardStatus: sameStage ? runtime.boardStatus : task.status,
      state: "starting",
    };
    this.persistence.writeReconcilerRuntime(starting);
    const boardStatus = restoreInitialBoardStatus
      ? (await this.boardStatuses()).inProgress
      : starting.boardStatus;
    await this.#activate(
      task,
      runtime.instanceId,
      stageId,
      starting,
      boardStatus,
      restoreInitialBoardStatus,
    );
  }

  async #raiseSynchronizationError(
    runtime: ReconcilerRuntimeRecord,
    code: string,
    error: unknown,
  ): Promise<void> {
    const attentionId = `production:${code}:task:${runtime.taskId}:${runtime.instanceId}`;
    if (await this.attention.has(attentionId)) return;
    await this.attention.raise({
      attentionId,
      code,
      error: errorDetail(error),
      instanceId: runtime.instanceId,
      kind: "production-error",
      message: `Instance ${runtime.instanceId} synchronization failed: ${describeError(error)}`,
      taskId: runtime.taskId,
    });
  }

  async #activate(
    task: BoardTask,
    instanceId: string,
    stageId: string,
    starting: ReconcilerRuntimeRecord,
    boardStatus: string = starting.boardStatus,
    mirrorBoardStatus: boolean = false,
  ): Promise<void> {
    const retryingIntent =
      starting.state === "starting" &&
      starting.stageId === stageId &&
      starting.sessionKey !== undefined &&
      starting.threadId !== undefined;
    const priorSessions = this.persistence
      .listSessionRuntime()
      .filter(
        (session) =>
          session.instanceId === instanceId && session.stageId === stageId,
      );
    const intendedSession = retryingIntent
      ? priorSessions.find(
          (session) => session.sessionKey === starting.sessionKey,
        )
      : undefined;
    const activation =
      intendedSession === undefined
        ? priorSessions.reduce(
            (maximum, session) => Math.max(maximum, session.activation),
            0,
          ) + 1
        : intendedSession.activation;
    const sessionKey = retryingIntent
      ? starting.sessionKey!
      : `${instanceId}:${stageId}:${activation}`;
    const threadId = retryingIntent
      ? starting.threadId!
      : stableUuid(`${sessionKey}:thread`);
    this.persistence.writeReconcilerRuntime({
      ...starting,
      sessionKey,
      stageEnteredAt: this.now(),
      stageId,
      threadId,
    });
    let idIndex = 0;
    const nextId = (): string => {
      const value =
        idIndex === 0
          ? threadId
          : stableUuid(`${sessionKey}:dispatch:${idIndex}`);
      idIndex += 1;
      return value;
    };
    const session = this.configuration.session;
    const stage = await readProductionHandoffStage({
      instanceId,
      persistence: this.persistence,
      repositoryRoot: this.templateAuthority.repositoryRoot,
      stageId,
    });
    if (stage.contractIssue !== undefined) {
      const attentionId = `${sessionKey}:advance-output:${stage.contractIssue.field}`;
      if (!(await this.attention.has(attentionId))) {
        const priorStage =
          stage.contractIssue.priorStageId === undefined
            ? "the prior stage"
            : `stage ${JSON.stringify(stage.contractIssue.priorStageId)}`;
        await this.attention.raise({
          attentionId,
          code: "advance-output-contract-missing",
          instanceId,
          kind: "lifecycle-resolution",
          message: `Remediation stage ${JSON.stringify(stageId)} received no ${stage.contractIssue.field} field from ${priorStage}; activation continues with no reviewer findings`,
          taskId: task.id,
        });
      }
    }
    const repository = this.routing.repositoryForStage(
      task,
      stage.repositoryName,
    );
    const projectId = this.projects.projectForTask(task);
    this.persistence.writeSessionRuntime({
      activation,
      instanceId,
      projectId,
      repositoryName: repository.name,
      sessionKey,
      stageId,
      threadId,
    });
    try {
      await bootstrapStageSession(
        {
          handoff: {
            skillPointer: session.skillPointer,
            stage: stage.handoff,
            taskContract: taskContract(task),
          },
          instanceId,
          interactionMode: session.interactionMode,
          modelSelection: { instanceId: session.driver, model: session.model },
          projectId,
          providerContext: {
            cliVersion: session.cliVersion,
            driver: session.driver,
            lifecycle: "independent",
          },
          runtimeMode: session.runtimeMode,
          sessionKey,
          task: task.frontMatter,
          taskId: task.id,
          title: heddleSessionTitle(task.id, `${stageId}-${activation}`),
          worktree: {
            baseRef: session.baseRef,
            branch: `heddle/task-${task.id}`,
            repositoryName: repository.name,
            repositoryRoot: repository.repositoryRoot,
            worktreeName: String(task.id),
            ...(session.worktreesRoot === undefined
              ? {}
              : { worktreesRoot: session.worktreesRoot }),
          },
        },
        {
          activationEvents: this.persistence,
          nextId,
          persistence: this.persistence,
          resolveSystemPrompt: this.resolveSystemPrompt,
          templateAuthority: this.templateAuthority,
          t3: {
            ...(this.t3.applyHarnessToolTimeout === undefined
              ? {}
              : {
                  applyHarnessToolTimeout: (value) =>
                    this.t3.applyHarnessToolTimeout!(value),
                }),
            dispatch: (command, providerContext) =>
              this.t3.dispatch(command, providerContext),
          },
        },
      );
    } catch (error) {
      await this.mirrorBoardStatus(task.id, starting.boardStatus).catch(
        () => undefined,
      );
      if (
        !(error instanceof HandoffRenderError) &&
        !(error instanceof HandoffTemplateError)
      ) {
        throw error;
      }
      const attentionId = `${sessionKey}:handoff-render`;
      if (!(await this.attention.has(attentionId))) {
        await this.attention.raise({
          attentionId,
          code: "handoff-render-failed",
          instanceId,
          kind: "lifecycle-resolution",
          message: error.message,
          taskId: task.id,
        });
      }
      throw new AttentionVisibleError(error);
    }
    this.persistence.writeReconcilerRuntime({
      ...starting,
      boardStatus,
      sessionKey,
      stageEnteredAt: this.now(),
      stageId,
      state: "waiting",
      threadId,
    });
    if (mirrorBoardStatus) {
      await this.mirrorBoardStatus(task.id, boardStatus);
    }
  }
}
