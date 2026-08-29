// ---
// relationships:
//   implements: heddle
// ---

import { resolve } from "node:path";

import { KanbanBoardAdapter } from "../board-adapter/index.js";
import type {
  ConsoleAttentionActionPort,
  ConsoleBlueprintEditor,
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
import {
  BlueprintArtifactEditor,
  LifecycleEngine,
  LifecycleResolver,
} from "../engine/index.js";
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
import type { SubagentCoordinator } from "../subagents/index.js";
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
import { ProductionConsoleState } from "./console-state.js";
import { ProductionScheduler } from "./scheduler.js";
import {
  createProductionSubagentCoordinator,
  productionSessionTargets,
} from "./subagent-composition.js";
import { ProductionAttentionActions } from "./attention-actions.js";

export type ProductionT3Client = SessionT3Client & SessionObservationT3Client;

export type ProductionCompositionOptions = {
  afterEscalationEffect?: (
    effect: "attention" | "pushover",
    attentionId: string,
  ) => Promise<void> | void;
  afterPushoverTransportSuccess?: (
    message: Parameters<PushoverTransport["send"]>[0],
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
  blueprintEditor: ConsoleBlueprintEditor;
  close(): Promise<void>;
  consoleActions: ConsoleAttentionActionPort;
  consoleState: ConsoleStateSource;
  escalation: EscalationCoordinator;
  lifecycle: LifecycleEngine;
  mcp: WorkflowMcpHttpHandler;
  persistence: SqlitePersistence;
  scheduler: ProductionScheduler;
  subagents: SubagentCoordinator;
  start(): Promise<void>;
};

const activeWorkspaces = new Set<string>();

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
      options.afterPushoverTransportSuccess,
    );
    const effects = createMechanicalNodeEffects({ board });
    const lifecycle = new LifecycleEngine({
      effects,
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
    const pacing = new DispatchPacingGate(
      configuration.pacing,
      options.providerUsage,
    );
    let subagents: SubagentCoordinator | undefined;
    const observer = new SessionObserver({
      attention,
      childStops: {
        onObserved: async (target, result) => {
          if (subagents === undefined) {
            throw new Error("Production subagent composition is not active");
          }
          await subagents.onObserved(target, result);
        },
      },
      escalations: escalation,
      persistence,
      t3,
      thresholds: configuration.observationThresholds,
    });
    const coordinator = createProductionSubagentCoordinator({
      configuration,
      observer,
      pacing,
      persistence,
      t3,
    });
    subagents = coordinator;
    const consoleActions = new ProductionAttentionActions(
      persistence,
      attention,
      escalation,
      observer,
    );
    const reconciler = new Reconciler({
      attention,
      board,
      instances,
      lifecycleResolver: new LifecycleResolver(configuration.repositoryRoot),
      pacing: {
        evaluator: pacing,
      },
      staleThresholds: configuration.stageThresholds,
    });
    const scheduler = new ProductionScheduler({
      cadenceMilliseconds: configuration.cadenceMilliseconds,
      onError: options.onSchedulerError,
      pass: async () => {
        await reconciler.reconcile();
        await instances.synchronize(await board.readBoard());
        for (const session of productionSessionTargets(persistence!)) {
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
      subagentCoordinator: coordinator,
    });
    let closed = false;
    return {
      attention,
      board,
      blueprintEditor: new BlueprintArtifactEditor({
        effects,
        repositoryRoot: configuration.repositoryRoot,
      }),
      consoleActions,
      consoleState: new ProductionConsoleState(
        persistence,
        attention,
        configuration.repositoryRoot,
      ),
      escalation,
      lifecycle,
      mcp,
      persistence,
      scheduler,
      subagents: coordinator,
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
