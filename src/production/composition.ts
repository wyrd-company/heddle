// ---
// relationships:
//   implements: heddle
// ---

import { resolve } from "node:path";

import { KanbanBoardAdapter } from "../board-adapter/index.js";
import type {
  ConsoleAttention,
  ConsoleEvent,
  ConsoleInstance,
  ConsoleStateSource,
} from "../console/index.js";
import {
  createMechanicalNodeEffects,
  SessionObserver,
  steerStageSession,
  T3ControlPlaneClient,
  type SessionObservationT3Client,
  type SessionT3Client,
} from "../control-plane/index.js";
import { LifecycleEngine, LifecycleResolver } from "../engine/index.js";
import {
  createWorkflowMcpHttpHandler,
  EscalationCoordinator,
  type ParentEscalation,
  type WorkflowMcpHttpHandler,
} from "../mcp-server/index.js";
import {
  DispatchPacingGate,
  type ProviderUsageSource,
} from "../pacing/index.js";
import { SqlitePersistence } from "../persistence/index.js";
import { Reconciler } from "../reconciler/index.js";
import {
  DurableAttentionQueue,
  DurablePushoverNotifier,
  HttpPushoverTransport,
  type PushoverTransport,
} from "./durable-adapters.js";
import {
  validateProductionConfiguration,
  type ProductionConfiguration,
} from "./configuration.js";
import { ProductionInstanceController } from "./instance-controller.js";
import { ProductionScheduler } from "./scheduler.js";

export type ProductionT3Client = SessionT3Client & SessionObservationT3Client;

export type ProductionCompositionOptions = {
  afterEscalationEffect?: (
    effect: "attention" | "pushover",
    attentionId: string,
  ) => Promise<void> | void;
  configuration: ProductionConfiguration;
  onSchedulerError?: (error: unknown) => void;
  providerUsage: ProviderUsageSource;
  pushoverTransport?: PushoverTransport;
  t3?: ProductionT3Client;
};

export type ProductionComposition = {
  attention: DurableAttentionQueue;
  board: KanbanBoardAdapter;
  close(): Promise<void>;
  consoleState: ConsoleStateSource;
  escalation: EscalationCoordinator;
  lifecycle: LifecycleEngine;
  mcp: WorkflowMcpHttpHandler;
  persistence: SqlitePersistence;
  scheduler: ProductionScheduler;
  start(): Promise<void>;
};

const activeWorkspaces = new Set<string>();

class ProductionConsoleState implements ConsoleStateSource {
  public constructor(
    private readonly persistence: SqlitePersistence,
    private readonly attention: DurableAttentionQueue,
  ) {}

  async listAttention(): Promise<ConsoleAttention[]> {
    return this.attention.list();
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
}

export const createProductionComposition = (
  options: ProductionCompositionOptions,
): ProductionComposition => {
  const configuration = validateProductionConfiguration(options.configuration);
  const workspaceId = resolve(configuration.boardDirectory);
  if (activeWorkspaces.has(workspaceId)) {
    throw new Error(`A production composition already owns '${workspaceId}'`);
  }
  activeWorkspaces.add(workspaceId);
  let persistence: SqlitePersistence | undefined;
  try {
    const board = new KanbanBoardAdapter(configuration.boardDirectory);
    persistence = new SqlitePersistence({
      stateDirectory: configuration.stateDirectory,
    });
    const t3 = options.t3 ?? new T3ControlPlaneClient(configuration.t3);
    const attention = new DurableAttentionQueue(persistence);
    const pushover = new DurablePushoverNotifier(
      persistence,
      configuration.pushover,
      options.pushoverTransport ??
        new HttpPushoverTransport(configuration.pushover.apiUrl),
    );
    const lifecycle = new LifecycleEngine({
      effects: createMechanicalNodeEffects({ board }),
      persistence,
      repositoryRoot: configuration.repositoryRoot,
    });
    const instances = new ProductionInstanceController(
      configuration,
      persistence,
      lifecycle,
      t3,
    );
    const escalation = new EscalationCoordinator({
      attention: {
        raise: async (value) => {
          await attention.raise(value);
          await options.afterEscalationEffect?.("attention", value.attentionId);
        },
      },
      parent: {
        steer: async (pending: ParentEscalation) => {
          const parent = persistence!
            .listReconcilerRuntime()
            .find(({ sessionKey }) => sessionKey === pending.parentSessionKey);
          if (parent?.threadId === undefined) {
            throw new Error("Parent escalation thread is not active");
          }
          await steerStageSession(
            {
              interactionMode: configuration.session.interactionMode,
              message: `Child escalation ${pending.attentionId} requires an answer`,
              providerContext: {
                cliVersion: configuration.session.cliVersion,
                driver: configuration.session.driver,
                lifecycle: "independent",
              },
              runtimeMode: configuration.session.runtimeMode,
              threadId: parent.threadId,
            },
            { t3 },
          );
        },
      },
      persistence,
      pushover: {
        send: async (value) => {
          await pushover.send(value);
          await options.afterEscalationEffect?.("pushover", value.attentionId);
        },
      },
    });
    const observer = new SessionObserver({
      attention,
      escalations: escalation,
      persistence,
      t3,
      thresholds: configuration.observationThresholds,
    });
    const reconciler = new Reconciler({
      attention,
      board,
      instances,
      lifecycleResolver: new LifecycleResolver(configuration.repositoryRoot),
      pacing: {
        evaluator: new DispatchPacingGate(
          configuration.pacing,
          options.providerUsage,
        ),
      },
      staleThresholds: configuration.stageThresholds,
    });
    const scheduler = new ProductionScheduler({
      cadenceMilliseconds: configuration.cadenceMilliseconds,
      onError: options.onSchedulerError,
      pass: async () => {
        await reconciler.reconcile();
        await instances.synchronize(await board.readBoard());
        for (const session of persistence!.listSessionRuntime()) {
          await observer.observe({
            instanceId: session.instanceId,
            sessionKey: session.sessionKey,
            threadId: session.threadId,
          });
        }
      },
      stopTimeoutMilliseconds: configuration.stopTimeoutMilliseconds,
    });
    const mcp = createWorkflowMcpHttpHandler({
      escalationCoordinator: escalation,
      lifecycle,
      persistence,
    });
    let closed = false;
    return {
      attention,
      board,
      consoleState: new ProductionConsoleState(persistence, attention),
      escalation,
      lifecycle,
      mcp,
      persistence,
      scheduler,
      start: () => scheduler.start(),
      close: async () => {
        if (closed) return;
        await scheduler.stop();
        await mcp.close();
        persistence!.close();
        activeWorkspaces.delete(workspaceId);
        closed = true;
      },
    };
  } catch (error) {
    persistence?.close();
    activeWorkspaces.delete(workspaceId);
    throw error;
  }
};
