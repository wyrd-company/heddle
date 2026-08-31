// ---
// relationships:
//   implements: heddle
// ---

import {
  buildConsoleLifecycleSnapshot,
  type ConsoleAttention,
  type ConsoleEvent,
  type ConsoleInstance,
  ConsoleLifecycleNotStartedError,
  ConsoleLifecycleUnavailableError,
  type ConsoleLifecycleSnapshot,
  type ConsoleStateSource,
} from "../console/index.js";
import { GitBlueprintStore, readLifecycleContext } from "../engine/index.js";
import type { SqlitePersistence } from "../persistence/index.js";
import type { DurableAttentionQueue } from "./durable-adapters.js";

const inspectUpstreamRebaseTarget = async (
  repositoryRoot: string,
  sourceRef: string,
  blueprintPath: string,
) => {
  try {
    return await new GitBlueprintStore(repositoryRoot, {
      sourceRef,
    }).inspect(blueprintPath);
  } catch {
    return undefined;
  }
};

export class ProductionConsoleState implements ConsoleStateSource {
  public constructor(
    private readonly persistence: SqlitePersistence,
    private readonly attention: DurableAttentionQueue,
    private readonly repositoryRoot: string | ((instanceId: string) => string),
    private readonly sourceRef: string,
  ) {}

  async listAttention(): Promise<ConsoleAttention[]> {
    return this.attention.list();
  }

  async listCorrelationTokens(): Promise<string[]> {
    return this.persistence
      .listInstances()
      .flatMap(({ state }) => Object.values(state.correlationTokens));
  }

  async listEvents(input: {
    afterSequence: number;
    instanceId?: string;
  }): Promise<ConsoleEvent[]> {
    return this.persistence
      .listInstances()
      .filter(
        ({ instanceId }) =>
          input.instanceId === undefined || instanceId === input.instanceId,
      )
      .flatMap(({ instanceId }) =>
        this.persistence.replayEvents(instanceId, input.afterSequence),
      )
      .sort((left, right) => left.sequence - right.sequence);
  }

  async listInstances(): Promise<ConsoleInstance[]> {
    return this.persistence.listReconcilerRuntime().map((runtime) => ({
      ...(runtime.deferral === undefined
        ? {}
        : { deferral: runtime.deferral as ConsoleInstance["deferral"] }),
      instanceId: runtime.instanceId,
      ...(runtime.stageEnteredAt === undefined
        ? {}
        : { stageEnteredAt: runtime.stageEnteredAt }),
      ...(runtime.stageId === undefined ? {} : { stageId: runtime.stageId }),
      taskId: runtime.taskId,
    }));
  }

  async readLifecycle(input: {
    afterSequence: number;
    taskId: number;
  }): Promise<ConsoleLifecycleSnapshot> {
    const runtimes = this.persistence
      .listReconcilerRuntime()
      .filter(({ taskId }) => taskId === input.taskId);
    if (runtimes.length === 0) {
      throw new ConsoleLifecycleNotStartedError(
        `Task ${input.taskId} has no production lifecycle instance`,
      );
    }
    if (runtimes.length !== 1) {
      throw new Error(
        `Task ${input.taskId} has more than one production lifecycle identity`,
      );
    }
    const runtime = runtimes[0]!;
    const instance = this.persistence.getInstance(runtime.instanceId);
    if (instance === undefined) {
      throw new ConsoleLifecycleUnavailableError(
        `Task ${input.taskId} lifecycle instance is unavailable`,
      );
    }
    const context = readLifecycleContext(instance);
    const repositoryRoot =
      typeof this.repositoryRoot === "string"
        ? this.repositoryRoot
        : this.repositoryRoot(instance.instanceId);
    const [blueprint, target] = await Promise.all([
      new GitBlueprintStore(repositoryRoot).read(
        context.blueprintBlobHash,
        context.blueprintPath,
      ),
      inspectUpstreamRebaseTarget(
        repositoryRoot,
        this.sourceRef,
        context.blueprintPath,
      ),
    ]);
    const executionHistories = await Promise.all(
      context.executionIds.map(async (executionId) => ({
        events: await this.persistence.flowcraftHistory.replay(executionId),
        executionId,
      })),
    );
    return buildConsoleLifecycleSnapshot({
      afterSequence: input.afterSequence,
      blueprint,
      blueprintBlobHash: context.blueprintBlobHash,
      blueprintPath: context.blueprintPath,
      currentStageIds: [...context.awaitingNodeIds],
      executionHistories,
      instanceId: instance.instanceId,
      rebase: {
        targetBlueprintBlobHash: target?.blobHash ?? context.blueprintBlobHash,
        targetStateIds:
          target?.blueprint.nodes
            .filter(({ uses }) => uses === "wait")
            .map(({ id }) => id) ?? [],
      },
      status: context.status,
      taskId: input.taskId,
    });
  }
}
