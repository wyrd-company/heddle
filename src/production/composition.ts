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
  GitHandoffTemplateStore,
  resolveBuiltInSystemPrompt,
  SessionObserver,
  steerStageSession,
  T3ControlPlaneClient,
  type MechanicalBoardStatuses,
  type SessionObservationT3Client,
  type SessionTemplateAuthority,
  type SessionT3Client,
  type SystemPromptResolver,
} from "../control-plane/index.js";
import {
  type LifecycleEffect,
  validateBlueprintToolRegistry,
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
import { OrganizationBlueprintRepository } from "./blueprint-repository.js";
import { EpicProjectCoordinator } from "./epic-projects.js";
import { ProductionLifecycleRouter } from "./lifecycle-router.js";
import { LifecycleAttentionBridge } from "./lifecycle-attention-bridge.js";
import { productionErrorAttention } from "./error-visibility.js";
import { OrganizationBlueprintArtifactEditor } from "./product-blueprint-editor.js";
import { ProductLifecycleResolver } from "./product-lifecycle-resolver.js";
import { ProductRoutingCatalog } from "./product-routing.js";
import { pageSessionAttentions } from "./session-attention-paging.js";

export type ProductionT3Client = SessionT3Client & SessionObservationT3Client;

export type ProductionCompositionOptions = {
  afterEscalationEffect?: (
    effect: "attention" | "pushover",
    attentionId: string,
  ) => Promise<void> | void;
  afterPushoverTransportSuccess?: (
    message: Parameters<PushoverTransport["send"]>[0],
  ) => Promise<void> | void;
  blueprintsRepositoryRoot: string;
  configuration: ProductionConfiguration;
  onSchedulerError?: (error: unknown) => void;
  providerUsage: ProviderUsageSource;
  pushoverTransport?: PushoverTransport;
  resolveSystemPrompt?: SystemPromptResolver;
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
  lifecycle: ProductionLifecycleRouter;
  mcp: WorkflowMcpHttpHandler;
  persistence: SqlitePersistence;
  scheduler: ProductionScheduler;
  subagents: SubagentCoordinator;
  start(): Promise<void>;
};

const activeWorkspaces = new Set<string>();

const mechanicalBoardStatuses = async (
  board: KanbanBoardAdapter,
): Promise<MechanicalBoardStatuses> => {
  const configured = new Set(await board.readBoardStatuses());
  const requireStatus = (status: string): string => {
    if (!configured.has(status)) {
      throw new Error(
        `Board configuration is missing required mechanical status '${status}'`,
      );
    }
    return status;
  };
  return {
    completed: requireStatus("done"),
    inProgress: requireStatus("in-progress"),
    merged: requireStatus("retrospective"),
    review: requireStatus("review"),
  };
};

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
    const boardStatuses = () => mechanicalBoardStatuses(board);
    persistence = new SqlitePersistence({
      stateDirectory: configuration.stateDirectory,
    });
    const t3 = options.t3 ?? new T3ControlPlaneClient(configuration.t3);
    const resolveSystemPrompt =
      options.resolveSystemPrompt ?? resolveBuiltInSystemPrompt;
    const attention = new DurableAttentionQueue(persistence);
    const blueprintRepository = new OrganizationBlueprintRepository(
      resolve(options.blueprintsRepositoryRoot),
      persistence,
      attention,
    );
    const handoffTemplateStore = new GitHandoffTemplateStore(
      blueprintRepository.repositoryRoot,
    );
    const templateAuthority: SessionTemplateAuthority = {
      readHandoffTemplate: (reference) => handoffTemplateStore.read(reference),
      repositoryRoot: blueprintRepository.repositoryRoot,
    };
    const pushover = new DurablePushoverNotifier(
      persistence,
      configuration.pushover,
      options.pushoverTransport ??
        new HttpPushoverTransport(configuration.pushover.apiUrl),
      options.afterPushoverTransportSuccess,
    );
    const effects: Record<string, LifecycleEffect> =
      createMechanicalNodeEffects({ board, statuses: boardStatuses });
    const routing = new ProductRoutingCatalog(configuration);
    const lifecycle = new ProductionLifecycleRouter({
      effects,
      persistence,
      repositoryRoot: blueprintRepository.repositoryRoot,
      sourceRef: blueprintRepository.sourceRef,
    });
    const projects = new EpicProjectCoordinator(
      configuration,
      persistence,
      routing,
      t3,
      undefined,
      undefined,
      attention,
    );
    const instances = new ProductionInstanceController(
      configuration,
      persistence,
      lifecycle,
      routing,
      projects,
      attention,
      t3,
      resolveSystemPrompt,
      templateAuthority,
      boardStatuses,
      (taskId, status) => board.mirrorTaskStatus(taskId, status),
    );
    const lifecycleAttentionBridge = new LifecycleAttentionBridge(
      persistence,
      attention,
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
          await pushover.send({
            attentionId: value.attentionId,
            instanceId: value.instanceId,
            message: `Heddle escalation in ${value.stage}`,
          });
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
      attention,
      board,
      configuration,
      observer,
      pacing,
      persistence,
      resolveSystemPrompt,
      t3,
      templateAuthority,
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
      lifecycleResolver: new ProductLifecycleResolver(
        routing,
        blueprintRepository,
      ),
      pacing: {
        evaluator: pacing,
      },
      staleThresholds: configuration.stageThresholds,
    });
    const mcp = createWorkflowMcpHttpHandler({
      board,
      escalationCoordinator: escalation,
      lifecycle,
      persistence,
      subagentCoordinator: coordinator,
    });
    const raiseSessionProductionError = async (
      code: "session-observation-failed" | "session-page-delivery-failed",
      error: unknown,
      session: { instanceId: string; sessionKey: string },
    ): Promise<void> => {
      const runtime = persistence!
        .listReconcilerRuntime()
        .find(({ instanceId }) => instanceId === session.instanceId);
      if (runtime === undefined) throw error;
      const summary =
        code === "session-observation-failed"
          ? `Session ${session.sessionKey} observation failed`
          : `Session ${session.sessionKey} page delivery failed`;
      const failure = productionErrorAttention({
        code,
        error,
        instanceId: session.instanceId,
        summary,
        taskId: runtime.taskId,
      });
      if (!(await attention.has(failure.attentionId))) {
        await attention.raise(failure);
      }
    };
    const scheduler = new ProductionScheduler({
      cadenceMilliseconds: configuration.cadenceMilliseconds,
      onError: async (error) => {
        const failure = productionErrorAttention({
          code: "scheduler-pass-failed",
          error,
          summary: "Production reconciliation pass failed",
          varyByError: true,
        });
        try {
          if (!(await attention.has(failure.attentionId))) {
            await attention.raise(failure);
          }
        } finally {
          await options.onSchedulerError?.(error);
        }
      },
      pass: async () => {
        await blueprintRepository.synchronize();
        await validateBlueprintToolRegistry(
          blueprintRepository.repositoryRoot,
          mcp.toolNames,
        );
        await escalation.replayPendingRoutes();
        const before = await board.readBoard();
        await projects.reconcile(before);
        routing.update(before);
        await instances.synchronize(before);
        await reconciler.reconcile();
        const after = await board.readBoard();
        await projects.reconcile(after);
        routing.update(after);
        await instances.synchronize(after);
        for (const session of productionSessionTargets(persistence!)) {
          let observation: Awaited<ReturnType<SessionObserver["observe"]>>;
          try {
            observation = await observer.observe({
              instanceId: session.instanceId,
              sessionKey: session.sessionKey,
              threadId: session.threadId,
            });
          } catch (error) {
            await raiseSessionProductionError(
              "session-observation-failed",
              error,
              session,
            );
            continue;
          }
          try {
            await pageSessionAttentions(observation.attentions, pushover);
          } catch (error) {
            await raiseSessionProductionError(
              "session-page-delivery-failed",
              error,
              session,
            );
          }
        }
        await lifecycleAttentionBridge.flush();
      },
      stopTimeoutMilliseconds: configuration.stopTimeoutMilliseconds,
    });
    let closed = false;
    return {
      attention,
      board,
      blueprintEditor: new OrganizationBlueprintArtifactEditor({
        effects,
        repository: blueprintRepository,
      }),
      consoleActions,
      consoleState: new ProductionConsoleState(
        persistence,
        attention,
        blueprintRepository.repositoryRoot,
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
