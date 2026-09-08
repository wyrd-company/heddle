// ---
// relationships:
//   implements: heddle
// ---

import { createHash } from "node:crypto";

import type { BoardTask } from "../board-adapter/index.js";
import type { AgentNameAllocator } from "../agent-names/index.js";
import { AttentionVisibleError } from "../attention-visible-error.js";
import { describeError } from "../error-details.js";
import {
  bootstrapStageSession,
  HandoffRenderError,
  HandoffTemplateError,
  mechanicalChangeContextKey,
  type SessionT3Client,
  type SessionTemplateAuthority,
  type SystemPromptResolver,
} from "../control-plane/index.js";
import {
  readLifecycleContext,
  UnexpectedLandingError,
  type LifecycleContextRecord,
  type LifecycleSnapshot,
  type MechanicalNodeUse,
} from "../engine/index.js";
import type { PacingDeferral } from "../pacing/index.js";
import type {
  JsonValue,
  IncidentRuntimeRecord,
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
import type { ResolvedProductionConfiguration } from "./configuration.js";
import {
  createProductionErrorAttention,
  type ProductionErrorCode,
} from "./error-visibility.js";
import { heddleSessionTitle } from "./session-title.js";
import {
  bindResolvedSession,
  modelSelectionFromBinding,
  providerContextFromBinding,
} from "./session-binding.js";
import { readProductionHandoffStage } from "./stage-handoff.js";
import {
  resolveStageSessionSelection,
  StartupProviderSelectionResolver,
  type StageProviderSelectionResolver,
} from "./stage-session-selection.js";
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

const synchronizationAttentionId = (
  runtime: ReconcilerRuntimeRecord,
  code: ProductionErrorCode,
): string => `production:${code}:task:${runtime.taskId}:${runtime.instanceId}`;

export class ProductionInstanceController implements ReconcilerInstanceController {
  public constructor(
    private readonly configuration: ResolvedProductionConfiguration,
    private readonly persistence: SqlitePersistence,
    private readonly lifecycle: ProductionLifecycleRouter,
    private readonly routing: ProductRoutingCatalog,
    private readonly projects: EpicProjectCoordinator,
    private readonly attention: ReconcilerAttentionQueue,
    private readonly t3: SessionT3Client,
    private readonly workflowMcpEndpoint: string,
    private readonly resolveSystemPrompt: SystemPromptResolver,
    private readonly templateAuthority: SessionTemplateAuthority,
    private readonly boardStatusFor: (
      instanceId: string,
      uses: MechanicalNodeUse,
    ) => Promise<string | undefined> = async () => undefined,
    private readonly mirrorBoardStatus: (
      taskId: number,
      status: string,
    ) => Promise<void> = async () => undefined,
    private readonly now: () => number = Date.now,
    private readonly providerSelection?: StageProviderSelectionResolver,
    private readonly agentNames?: AgentNameAllocator,
  ) {}

  private sessionSelectionResolver(): StageProviderSelectionResolver {
    return (
      this.providerSelection ??
      new StartupProviderSelectionResolver(
        this.configuration.session.resolvedSelections,
      )
    );
  }

  async listInstances(): Promise<ReconcilerInstance[]> {
    const runtimes = this.persistence.listReconcilerRuntime();
    const runtimeByInstanceId = new Map(
      runtimes.map((runtime) => [runtime.instanceId, runtime]),
    );
    const sessionByKey = new Map(
      this.persistence
        .listSessionRuntime()
        .map((session) => [session.sessionKey, session]),
    );
    const activeAttentionIds = new Set(
      this.persistence.listAttention().map(({ attentionId }) => attentionId),
    );
    const topLevel = runtimes.map((runtime) => {
      const boundSession =
        runtime.sessionKey === undefined
          ? undefined
          : sessionByKey.get(runtime.sessionKey);
      const provider =
        boundSession?.binding.providerInstanceId ?? runtime.provider;
      const boardStatusMirrorBlocked = activeAttentionIds.has(
        synchronizationAttentionId(runtime, "instance-synchronization-failed"),
      );
      return {
        boardStatus: runtime.boardStatus,
        ...(boardStatusMirrorBlocked ? { boardStatusMirrorBlocked } : {}),
        ...(runtime.deferral === undefined
          ? {}
          : { deferral: deferral(runtime.deferral) }),
        depth: 0,
        instanceId: runtime.instanceId,
        ...(provider === undefined ? {} : { provider }),
        ...(runtime.stageEnteredAt === undefined
          ? {}
          : { stageEnteredAt: runtime.stageEnteredAt }),
        ...(runtime.stageId === undefined ? {} : { stageId: runtime.stageId }),
        state: runtime.state,
        taskId: runtime.taskId,
      };
    });
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
    const lifecycleExistedAtStart =
      this.persistence.getInstance(input.instanceId) !== undefined;
    const previous = this.persistence
      .listReconcilerRuntime()
      .find(({ instanceId }) => instanceId === input.instanceId);
    const provider = input.dispatch?.provider ?? previous?.provider;
    let starting: ReconcilerRuntimeRecord = {
      ...(previous?.state === "starting" ? previous : {}),
      boardStatus: input.task.status,
      instanceId: input.instanceId,
      ...(provider === undefined ? {} : { provider }),
      state: "starting",
      taskId: input.task.id,
    };
    const priorSessions = this.persistence
      .listSessionRuntime()
      .filter(({ instanceId }) => instanceId === input.instanceId);
    const retainedSession =
      starting.sessionKey === undefined
        ? undefined
        : priorSessions.find(
            ({ sessionKey }) => sessionKey === starting.sessionKey,
          );
    if (retainedSession !== undefined) {
      await this.agentNames?.prepareTask(
        input.instanceId,
        input.task.parent === undefined ? "soloist" : "team",
      );
      starting = {
        ...starting,
        provider: retainedSession.binding.providerInstanceId,
        sessionKey: retainedSession.sessionKey,
        stageId: retainedSession.stageId,
        threadId: retainedSession.threadId,
      };
      this.persistence.writeStartingSessionRuntime(starting, retainedSession);
    } else {
      const stageId =
        starting.stageId ??
        (await this.lifecycle.plannedStartStage({
          blueprintPath: input.blueprintPath,
          instanceId: input.instanceId,
        }));
      await this.agentNames?.prepareTask(
        input.instanceId,
        input.task.parent === undefined ? "soloist" : "team",
      );
      if (stageId === undefined) {
        this.persistence.writeReconcilerRuntime(starting);
      } else {
        const activation =
          priorSessions
            .filter((session) => session.stageId === stageId)
            .reduce(
              (maximum, session) => Math.max(maximum, session.activation),
              0,
            ) + 1;
        const sessionKey =
          starting.sessionKey ?? `${input.instanceId}:${stageId}:${activation}`;
        const threadId =
          starting.threadId ?? stableUuid(`${sessionKey}:thread`);
        const stage = await readProductionHandoffStage({
          instanceId: input.instanceId,
          persistence: this.persistence,
          repositoryRoot: this.templateAuthority.repositoryRoot,
          stageId,
        });
        const binding = bindResolvedSession(
          await resolveStageSessionSelection(
            {
              session: this.configuration.session,
              stageId,
              stageProviderAlias: stage.providerAlias,
              stageRuntimeMode: stage.runtimeMode,
              taskId: input.task.id,
              taskProviderAlias: input.task.providerAlias,
            },
            this.sessionSelectionResolver(),
          ),
          sessionKey,
          threadId,
        );
        starting = {
          ...starting,
          provider: binding.providerInstanceId,
          sessionKey,
          stageId,
          threadId,
        };
        this.persistence.writeStartingSessionRuntime(starting, {
          activation,
          binding,
          instanceId: input.instanceId,
          sessionKey,
          stageId,
          threadId,
        });
      }
    }

    const existing = this.persistence.getInstance(input.instanceId);
    const existingContext =
      existing === undefined ? undefined : readLifecycleContext(existing);
    const snapshot =
      existing === undefined ||
      existingContext?.pendingTransition?.kind === "start"
        ? await this.lifecycle
            .start({
              blueprintPath: input.blueprintPath,
              ...(existing === undefined ||
              existingContext?.pendingTransition?.initialContext === null
                ? {
                    initialContext: {
                      ...(await this.#mechanicalChange(
                        input.task,
                        input.instanceId,
                        input.repositoryName,
                      )),
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
        boardStatus:
          snapshot.status === "completed"
            ? ((await this.boardStatusFor(input.instanceId, "finalize")) ??
              starting.boardStatus)
            : starting.boardStatus,
        state: snapshot.status === "completed" ? "done" : "running",
      });
      return;
    }
    const preparedBoardStatus = await this.boardStatusFor(
      input.instanceId,
      "prepare-worktree",
    );
    const restoreInitialBoardStatus =
      lifecycleExistedAtStart &&
      starting.boardStatus === "todo" &&
      preparedBoardStatus !== undefined;
    await this.#activate(
      input.task,
      input.instanceId,
      stageId,
      starting,
      !lifecycleExistedAtStart || restoreInitialBoardStatus
        ? (preparedBoardStatus ?? input.task.status)
        : starting.boardStatus,
      restoreInitialBoardStatus,
    );
  }

  async activateIncident(
    task: BoardTask,
    runtime: IncidentRuntimeRecord,
    stageId: string,
  ): Promise<void> {
    const starting: ReconcilerRuntimeRecord = {
      boardStatus: "incident",
      instanceId: runtime.incidentId,
      ...(runtime.provider === undefined ? {} : { provider: runtime.provider }),
      ...(runtime.sessionKey === undefined
        ? {}
        : { sessionKey: runtime.sessionKey }),
      ...(runtime.stageEnteredAt === undefined
        ? {}
        : { stageEnteredAt: runtime.stageEnteredAt }),
      ...(runtime.stageId === undefined ? {} : { stageId: runtime.stageId }),
      state: "starting",
      taskId: runtime.taskId,
      ...(runtime.threadId === undefined ? {} : { threadId: runtime.threadId }),
    };
    await this.#activate(
      task,
      runtime.incidentId,
      stageId,
      starting,
      "incident",
      false,
      (next) =>
        this.persistence.writeIncidentRuntime({
          ...runtime,
          ...(next.provider === undefined ? {} : { provider: next.provider }),
          ...(next.sessionKey === undefined
            ? {}
            : { sessionKey: next.sessionKey }),
          ...(next.stageEnteredAt === undefined
            ? {}
            : { stageEnteredAt: next.stageEnteredAt }),
          ...(next.stageId === undefined ? {} : { stageId: next.stageId }),
          state: next.state === "waiting" ? "waiting" : "starting",
          ...(next.threadId === undefined ? {} : { threadId: next.threadId }),
        }),
    );
  }

  async prepareIncidentStart(
    runtime: IncidentRuntimeRecord,
    stageId: string,
    task?: Pick<BoardTask, "id" | "providerAlias">,
  ): Promise<IncidentRuntimeRecord> {
    await this.agentNames?.prepareTask(runtime.incidentId, "soloist");
    const priorSessions = this.persistence
      .listSessionRuntime()
      .filter(
        (session) =>
          session.instanceId === runtime.incidentId &&
          session.stageId === stageId,
      );
    const activation =
      priorSessions.reduce(
        (maximum, session) => Math.max(maximum, session.activation),
        0,
      ) + 1;
    const sessionKey = `${runtime.incidentId}:${stageId}:${activation}`;
    const threadId = stableUuid(`${sessionKey}:thread`);
    const stage = await readProductionHandoffStage({
      instanceId: runtime.incidentId,
      persistence: this.persistence,
      repositoryRoot: this.templateAuthority.repositoryRoot,
      stageId,
    });
    const binding = bindResolvedSession(
      await resolveStageSessionSelection(
        {
          session: this.configuration.session,
          stageId,
          stageProviderAlias: stage.providerAlias,
          stageRuntimeMode: stage.runtimeMode,
          taskId: task?.id ?? runtime.taskId,
          taskProviderAlias: task?.providerAlias,
        },
        this.sessionSelectionResolver(),
      ),
      sessionKey,
      threadId,
    );
    const prepared: IncidentRuntimeRecord = {
      ...runtime,
      provider: binding.providerInstanceId,
      sessionKey,
      stageId,
      state: "starting",
      threadId,
    };
    this.persistence.writeStartingIncidentSessionRuntime(prepared, {
      activation,
      binding,
      instanceId: runtime.incidentId,
      sessionKey,
      stageId,
      threadId,
    });
    return prepared;
  }

  async #mechanicalChange(
    task: BoardTask,
    instanceId: string,
    repositoryName?: string,
  ): Promise<Record<string, JsonValue>> {
    let repository;
    try {
      repository = this.routing.repositoryForStage(task, repositoryName);
    } catch (error) {
      if (!(error instanceof TaskRoutingAttentionError)) throw error;
      await this.#raiseInitialRoutingAttention(instanceId, error);
      return {};
    }
    const session = this.configuration.session;
    return {
      [mechanicalChangeContextKey]: json({
        baseBranch: this.projects.baseBranchForTask(task),
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

  async #raiseInitialRoutingAttention(
    instanceId: string,
    error: TaskRoutingAttentionError,
  ): Promise<void> {
    const attentionId = `production:initial-routing-failed:task:${error.taskId}:${instanceId}`;
    if (await this.attention.has(attentionId)) return;
    await this.attention.raise({
      attentionId,
      code: error.code,
      instanceId,
      kind: "lifecycle-resolution",
      message: error.message,
      taskId: error.taskId,
    });
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
          if (runtime.state === "deferred" || runtime.state === "starting") {
            continue;
          }
          await this.#raiseSynchronizationError(
            runtime,
            "lifecycle-instance-absent",
            new Error(
              `Instance ${runtime.instanceId} has runtime state but no lifecycle state`,
            ),
          );
          continue;
        }
        await this.#resolveSynchronizationError(
          runtime,
          "lifecycle-instance-absent",
        );
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
          await this.#resolveSynchronizationError(
            runtime,
            "instance-synchronization-failed",
          );
          continue;
        }
        await this.#synchronizeSnapshot(task, runtime, context);
        await this.#resolveSynchronizationError(
          runtime,
          "instance-synchronization-failed",
        );
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
            ? ((await this.boardStatusFor(runtime.instanceId, "finalize")) ??
              runtime.boardStatus)
            : runtime.boardStatus,
        state: snapshot.status === "completed" ? "done" : "running",
      });
      return;
    }
    const sameStage = runtime.stageId === stageId;
    if (sameStage && runtime.state === "waiting") {
      const preparedBoardStatus = await this.boardStatusFor(
        runtime.instanceId,
        "prepare-worktree",
      );
      if (runtime.boardStatus === "todo" && preparedBoardStatus !== undefined) {
        this.persistence.writeReconcilerRuntime({
          ...runtime,
          boardStatus: preparedBoardStatus,
        });
        await this.mirrorBoardStatus(task.id, preparedBoardStatus);
      }
      return;
    }
    const restoreInitialBoardStatus =
      runtime.state === "starting" && runtime.boardStatus === "todo";
    const starting: ReconcilerRuntimeRecord = {
      ...runtime,
      boardStatus: sameStage ? runtime.boardStatus : task.status,
      state: "starting",
    };
    this.persistence.writeReconcilerRuntime(starting);
    const boardStatus = restoreInitialBoardStatus
      ? ((await this.boardStatusFor(runtime.instanceId, "prepare-worktree")) ??
        starting.boardStatus)
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
    code: ProductionErrorCode,
    error: unknown,
  ): Promise<void> {
    const attentionId = synchronizationAttentionId(runtime, code);
    if (await this.attention.has(attentionId)) {
      if (code === "lifecycle-instance-absent") {
        this.attention.reopen(attentionId);
      }
      return;
    }
    await this.attention.raise(
      createProductionErrorAttention({
        attentionId,
        code,
        error,
        instanceId: runtime.instanceId,
        message: `Instance ${runtime.instanceId} synchronization failed: ${describeError(error)}`,
        taskId: runtime.taskId,
      }),
    );
  }

  async #resolveSynchronizationError(
    runtime: ReconcilerRuntimeRecord,
    code: ProductionErrorCode,
  ): Promise<void> {
    const attentionId = synchronizationAttentionId(runtime, code);
    if (await this.attention.has(attentionId)) {
      this.attention.resolve(attentionId);
    }
  }

  async #activate(
    task: BoardTask,
    instanceId: string,
    stageId: string,
    starting: ReconcilerRuntimeRecord,
    boardStatus: string = starting.boardStatus,
    mirrorBoardStatus: boolean = false,
    writeRuntime: (runtime: ReconcilerRuntimeRecord) => void = (runtime) =>
      this.persistence.writeReconcilerRuntime(runtime),
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
    writeRuntime({
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
    const stage = await readProductionHandoffStage({
      instanceId,
      persistence: this.persistence,
      repositoryRoot: this.templateAuthority.repositoryRoot,
      stageId,
    });
    const agentName =
      stage.agentNameList === undefined
        ? undefined
        : await this.requireAgentNames().assign(
            instanceId,
            stage.agentNameList,
          );
    const session = this.configuration.session;
    const binding =
      intendedSession?.binding ??
      bindResolvedSession(
        await resolveStageSessionSelection(
          {
            session,
            stageId,
            stageProviderAlias: stage.providerAlias,
            stageRuntimeMode: stage.runtimeMode,
            taskId: task.id,
            taskProviderAlias: task.providerAlias,
          },
          this.sessionSelectionResolver(),
        ),
        sessionKey,
        threadId,
      );
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
      binding,
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
            stage: {
              ...stage.handoff,
              ...(agentName === undefined ? {} : { agentName }),
            },
            taskContract: taskContract(task),
          },
          instanceId,
          interactionMode: binding.interactionMode,
          modelSelection: modelSelectionFromBinding(binding),
          projectId,
          providerContext: providerContextFromBinding(binding),
          runtimeMode: binding.runtimeMode,
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
            registerWorkflowMcpProviderSession: (registration) =>
              this.t3.registerWorkflowMcpProviderSession(registration),
          },
          workflowMcpEndpoint: this.workflowMcpEndpoint,
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
    writeRuntime({
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

  private requireAgentNames(): AgentNameAllocator {
    if (this.agentNames === undefined) {
      throw new Error("Agent-name allocation is not configured");
    }
    return this.agentNames;
  }
}
