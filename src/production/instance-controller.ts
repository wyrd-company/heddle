// ---
// relationships:
//   implements: heddle
// ---

import { createHash } from "node:crypto";

import type { BoardTask } from "../board-adapter/index.js";
import {
  bootstrapStageSession,
  type SessionT3Client,
} from "../control-plane/index.js";
import { readLifecycleContext, type LifecycleEngine } from "../engine/index.js";
import type { PacingDeferral } from "../pacing/index.js";
import type {
  JsonValue,
  ReconcilerRuntimeRecord,
  SqlitePersistence,
} from "../persistence/index.js";
import type {
  DeferReconcilerInstanceInput,
  ReconcilerInstance,
  ReconcilerInstanceController,
  StartReconcilerInstanceInput,
} from "../reconciler/index.js";
import type { ProductionConfiguration } from "./configuration.js";
import { heddleSessionTitle } from "./session-title.js";

const json = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value)) as JsonValue;

const stableUuid = (seed: string): string => {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
};

const stageSlug = (stageId: string): string =>
  stageId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "stage";

const deferral = (value: JsonValue | undefined): PacingDeferral | undefined =>
  value as PacingDeferral | undefined;

export class ProductionInstanceController implements ReconcilerInstanceController {
  public constructor(
    private readonly configuration: ProductionConfiguration,
    private readonly persistence: SqlitePersistence,
    private readonly lifecycle: LifecycleEngine,
    private readonly t3: SessionT3Client,
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
    const previous = this.persistence
      .listReconcilerRuntime()
      .find(({ instanceId }) => instanceId === input.instanceId);
    const provider = input.dispatch?.provider ?? previous?.provider;
    const starting: ReconcilerRuntimeRecord = {
      boardStatus: "in-progress",
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
        ? await this.lifecycle.start({
            blueprintPath: input.blueprintPath,
            ...(existing === undefined
              ? {
                  initialContext: {
                    taskContract: json(input.task),
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

  async #activate(
    task: BoardTask,
    instanceId: string,
    stageId: string,
    starting: ReconcilerRuntimeRecord,
  ): Promise<void> {
    const sessionKey = `${instanceId}:${stageId}`;
    const threadId = stableUuid(`${sessionKey}:thread`);
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
    await bootstrapStageSession(
      {
        handoff: {
          skillPointer: session.skillPointer,
          stage: {
            kind: "standard",
            name: stageId,
            priorStageOutputs: [],
          },
          taskContract: json(task),
        },
        instanceId,
        interactionMode: session.interactionMode,
        modelSelection: { instanceId: session.driver, model: session.model },
        projectId: this.configuration.projectId,
        providerContext: {
          cliVersion: session.cliVersion,
          driver: session.driver,
          lifecycle: "independent",
        },
        runtimeMode: session.runtimeMode,
        sessionKey,
        title: heddleSessionTitle(task.id, stageId),
        worktree: {
          baseRef: session.baseRef,
          branch: `heddle/task-${task.id}-${stageSlug(stageId)}`,
          repositoryName: session.repositoryName,
          repositoryRoot: this.configuration.repositoryRoot,
          worktreeName: `task-${task.id}-${stageSlug(stageId)}`,
          ...(session.worktreesRoot === undefined
            ? {}
            : { worktreesRoot: session.worktreesRoot }),
        },
      },
      {
        nextId,
        persistence: this.persistence,
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
    this.persistence.writeReconcilerRuntime({
      ...starting,
      sessionKey,
      stageEnteredAt: this.now(),
      stageId,
      state: "waiting",
      threadId,
    });
  }
}
