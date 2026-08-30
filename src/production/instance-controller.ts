// ---
// relationships:
//   implements: heddle
// ---

import { createHash } from "node:crypto";

import type { BoardTask } from "../board-adapter/index.js";
import {
  bootstrapStageSession,
  HandoffRenderError,
  HandoffTemplateError,
  type SessionT3Client,
  type SystemPromptResolver,
} from "../control-plane/index.js";
import { readLifecycleContext } from "../engine/index.js";
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
import type { ProductionConfiguration } from "./configuration.js";
import { heddleSessionTitle } from "./session-title.js";
import { readProductionHandoffStage } from "./stage-handoff.js";
import type { EpicProjectCoordinator } from "./epic-projects.js";
import type { ProductionLifecycleRouter } from "./lifecycle-router.js";
import type { ProductRoutingCatalog } from "./product-routing.js";

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
    private readonly now: () => number = Date.now,
  ) {}

  async listInstances(): Promise<ReconcilerInstance[]> {
    return this.persistence.listReconcilerRuntime().map((runtime) => ({
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
  }

  async defer(input: DeferReconcilerInstanceInput): Promise<void> {
    this.persistence.writeReconcilerRuntime({
      boardStatus: input.boardStatus,
      deferral: json(input.deferral),
      instanceId: input.instanceId,
      provider: input.provider,
      state: "deferred",
      taskId: input.taskId,
    });
  }

  async start(input: StartReconcilerInstanceInput): Promise<void> {
    if (input.repositoryName === undefined) {
      throw new Error(`Task ${input.task.id} has no lifecycle repository`);
    }
    const previous = this.persistence
      .listReconcilerRuntime()
      .find(({ instanceId }) => instanceId === input.instanceId);
    const provider = input.dispatch?.provider ?? previous?.provider;
    const starting: ReconcilerRuntimeRecord = {
      ...(previous?.state === "starting" ? previous : {}),
      boardStatus: input.task.status,
      instanceId: input.instanceId,
      lifecycleRepositoryName: input.repositoryName,
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
        ? await this.lifecycle.start({
            blueprintPath: input.blueprintPath,
            repositoryName: input.repositoryName,
            ...(existing === undefined
              ? {
                  initialContext: {
                    taskContract: taskContract(input.task),
                    taskId: input.task.id,
                  },
                }
              : {}),
            instanceId: input.instanceId,
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
    await this.#activate(input.task, input.instanceId, stageId, starting);
  }

  async synchronize(tasks: readonly BoardTask[]): Promise<void> {
    const tasksById = new Map(tasks.map((task) => [task.id, task]));
    for (const runtime of this.persistence.listReconcilerRuntime()) {
      const record = this.persistence.getInstance(runtime.instanceId);
      if (record === undefined) continue;
      const context = readLifecycleContext(record);
      if (context.pendingTransition !== null) {
        this.persistence.writeReconcilerRuntime({
          ...runtime,
          state: "running",
        });
        continue;
      }
      const stageId = context.awaitingNodeIds[0];
      if (stageId === undefined) {
        this.persistence.writeReconcilerRuntime({
          ...runtime,
          boardStatus: context.status === "completed" ? "done" : "in-progress",
          state: context.status === "completed" ? "done" : "running",
        });
        continue;
      }
      if (runtime.stageId === stageId && runtime.state === "waiting") continue;
      const task = tasksById.get(runtime.taskId);
      if (task === undefined) {
        throw new Error(
          `Task ${runtime.taskId} is absent during lifecycle synchronization`,
        );
      }
      const starting: ReconcilerRuntimeRecord = {
        ...runtime,
        state: "starting",
      };
      this.persistence.writeReconcilerRuntime(starting);
      await this.#activate(task, runtime.instanceId, stageId, starting);
    }
  }

  async #activate(
    task: BoardTask,
    instanceId: string,
    stageId: string,
    starting: ReconcilerRuntimeRecord,
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
      repositoryRoot: this.repositoryRoot(starting.lifecycleRepositoryName),
      stageId,
    });
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
      throw error;
    }
    this.persistence.writeReconcilerRuntime({
      ...starting,
      boardStatus: "in-progress",
      sessionKey,
      stageEnteredAt: this.now(),
      stageId,
      state: "waiting",
      threadId,
    });
  }

  private repositoryRoot(repositoryName: string | undefined): string {
    if (repositoryName === undefined) {
      throw new Error("Lifecycle repository identity is absent");
    }
    const repository = this.configuration.products
      .flatMap(({ repos }) => repos)
      .find(({ name }) => name === repositoryName);
    if (repository === undefined) {
      throw new Error(
        `Lifecycle repository '${repositoryName}' is not configured`,
      );
    }
    return repository.repositoryRoot;
  }
}
