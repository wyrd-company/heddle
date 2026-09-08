// ---
// relationships:
//   implements: heddle
// ---

import { resolve } from "node:path";

import { KanbanBoardAdapter } from "../board-adapter/index.js";
import type {
  ConsoleAttentionActionPort,
  ConsoleBlueprintEditor,
  ConsoleBoard,
  ConsoleLifecycleActionPort,
  ConsoleStateSource,
} from "../console/index.js";
import {
  assertMechanicalBoardStatusConfigured,
  createMechanicalNodeEffects,
  GitHandoffTemplateStore,
  resolveBuiltInSystemPrompt,
  SessionObserver,
  steerStageSession,
  T3ControlPlaneClient,
  ProviderSelectionResolver,
  type SessionObservationT3Client,
  type SessionTemplateAuthority,
  type SessionT3Client,
  type SystemPromptResolver,
  type T3ProviderCatalogReader,
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
import {
  Reconciler,
  type ReconcilerInstanceController,
} from "../reconciler/index.js";
import type { SubagentCoordinator } from "../subagents/index.js";
import { isTodoState } from "../todo/index.js";
import {
  DurableAttentionQueue,
  DurablePushoverNotifier,
  HttpPushoverTransport,
  NotificationDeliveryError,
  type OperatorPage,
  type PushoverTransport,
} from "./durable-adapters.js";
import { ProductionErrorPager } from "./production-error-paging.js";
import {
  validateResolvedProductionConfiguration,
  type ResolvedProductionConfiguration,
} from "./configuration.js";
import { ProductionInstanceController } from "./instance-controller.js";
import { ProductionConsoleState } from "./console-state.js";
import { ProductionScheduler } from "./scheduler.js";
import { SchedulerPassAttentionLifecycle } from "./scheduler-pass-attention.js";
import {
  createProductionSubagentCoordinator,
  productionSessionBindingFor,
  productionSessionTargets,
} from "./subagent-composition.js";
import { providerContextFromBinding } from "./session-binding.js";
import { ProductionAttentionActions } from "./attention-actions.js";
import { OrganizationBlueprintRepository } from "./blueprint-repository.js";
import { EpicProjectCoordinator } from "./epic-projects.js";
import { ProductionLifecycleRouter } from "./lifecycle-router.js";
import { LifecycleAttentionBridge } from "./lifecycle-attention-bridge.js";
import {
  createProductionErrorAttention,
  notificationDeliveryErrorAttention,
  productionErrorAttention,
} from "./error-visibility.js";
import { OrganizationBlueprintArtifactEditor } from "./product-blueprint-editor.js";
import { ProductLifecycleResolver } from "./product-lifecycle-resolver.js";
import { ProductRoutingCatalog } from "./product-routing.js";
import { pageSessionAttentions } from "./session-attention-paging.js";
import { DynamicTaskAuthority } from "./dynamic-task-authority.js";
import { EpicOperationCoordinator } from "./epic-operation-coordinator.js";
import { ProductionIncidentCoordinator } from "./incident-coordinator.js";
import { SharedProjectCoordinator } from "./shared-project.js";

export type ProductionT3Client = SessionT3Client & SessionObservationT3Client;

export type ProductionCompositionOptions = {
  afterEscalationEffect?: (
    effect: "attention" | "pushover",
    attentionId: string,
  ) => Promise<void> | void;
  afterPushoverTransportSuccess?: (
    message: Parameters<PushoverTransport["send"]>[0],
  ) => Promise<void> | void;
  afterDynamicTaskBoardEffect?: (taskId: number) => Promise<void> | void;
  afterDynamicTaskIntentRecorded?: () => Promise<void> | void;
  blueprintsRepositoryRoot: string;
  configuration: ResolvedProductionConfiguration;
  onSchedulerError?: (error: unknown) => void;
  notificationNow?: () => number;
  providerUsage: ProviderUsageSource;
  providerResolver?: ProviderSelectionResolver;
  pushoverFetch?: typeof globalThis.fetch;
  pushoverTransport?: PushoverTransport;
  resolveSystemPrompt?: SystemPromptResolver;
  t3?: ProductionT3Client;
  workflowMcpEndpoint: string;
};

export type ProductionComposition = {
  attention: DurableAttentionQueue;
  board: KanbanBoardAdapter;
  blueprintEditor: ConsoleBlueprintEditor;
  close(): Promise<void>;
  consoleActions: ConsoleAttentionActionPort;
  consoleBoard: ConsoleBoard;
  consoleLifecycleActions: ConsoleLifecycleActionPort;
  consoleState: ConsoleStateSource;
  dynamicTasks: DynamicTaskAuthority;
  escalation: EscalationCoordinator;
  lifecycle: ProductionLifecycleRouter;
  instances: ReconcilerInstanceController;
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
  const configuration = validateResolvedProductionConfiguration(
    options.configuration,
  );
  const workspaceId = resolve(configuration.boardDirectory);
  if (activeWorkspaces.has(workspaceId)) {
    throw new Error(`A production composition already owns '${workspaceId}'`);
  }
  activeWorkspaces.add(workspaceId);
  let persistence: SqlitePersistence | undefined;
  try {
    const board = new KanbanBoardAdapter(configuration.boardDirectory);
    const boardStatuses = () => board.readBoardStatuses();
    persistence = new SqlitePersistence({
      stateDirectory: configuration.stateDirectory,
    });
    const t3 = options.t3 ?? new T3ControlPlaneClient(configuration.t3);
    const providerCatalog =
      "readProviderCatalog" in t3
        ? (t3 as ProductionT3Client & T3ProviderCatalogReader)
        : {
            readProviderCatalog: async () => {
              throw new Error("T3 provider catalog reader is not configured");
            },
          };
    const providerResolver =
      options.providerResolver ??
      new ProviderSelectionResolver(
        configuration.providerAliases,
        providerCatalog,
      );
    const resolveSystemPrompt =
      options.resolveSystemPrompt ?? resolveBuiltInSystemPrompt;
    const pushoverTransport =
      options.pushoverTransport ??
      new HttpPushoverTransport(
        configuration.pushover.apiUrl,
        options.pushoverFetch ?? globalThis.fetch,
      );
    const pushover = new DurablePushoverNotifier(
      persistence,
      configuration.pushover,
      pushoverTransport,
      options.afterPushoverTransportSuccess,
      options.notificationNow,
    );
    let attention: DurableAttentionQueue;
    const productionErrorPages = new ProductionErrorPager(
      persistence,
      pushover,
      options.notificationNow,
      {
        deliveryFailed: async (source, error) => {
          if (source.taskId === null) return;
          await attention.recordCurrentNotificationFailure(
            notificationDeliveryErrorAttention({
              error,
              ...(source.instanceId === null
                ? {}
                : { instanceId: source.instanceId }),
              stableId: source.attentionId,
              taskId: source.taskId,
            }),
          );
        },
      },
    );
    attention = new DurableAttentionQueue(persistence, productionErrorPages, [
      configuration.pushover.applicationToken,
      configuration.pushover.userKey,
      configuration.t3.accessToken,
    ]);
    const schedulerPassAttention = new SchedulerPassAttentionLifecycle(
      persistence,
      attention,
    );
    const epicOperations = new EpicOperationCoordinator();
    const dynamicTasks = new DynamicTaskAuthority(
      persistence,
      board,
      attention,
      {
        afterBoardEffect:
          options.afterDynamicTaskBoardEffect === undefined
            ? undefined
            : (task) => options.afterDynamicTaskBoardEffect!(task.id),
        afterIntentRecorded: options.afterDynamicTaskIntentRecorded,
        epicOperations,
      },
    );
    const blueprintRepository = new OrganizationBlueprintRepository(
      resolve(options.blueprintsRepositoryRoot),
      persistence,
      attention,
    );
    const handoffTemplateStore = new GitHandoffTemplateStore(
      blueprintRepository.repositoryRoot,
    );
    const templateAuthority: SessionTemplateAuthority = {
      readHandoffTemplate: (reference, skillNames) =>
        handoffTemplateStore.read(reference, skillNames),
      repositoryRoot: blueprintRepository.repositoryRoot,
    };
    const sendNotification = async (page: OperatorPage): Promise<void> => {
      await pushover.send(page);
      attention.resolveNotificationFailures(page.attentionId);
    };
    const effects: Record<string, LifecycleEffect> =
      createMechanicalNodeEffects({ board, statuses: boardStatuses });
    effects["complete"] = async () => ({});
    const routing = new ProductRoutingCatalog(configuration);
    const lifecycle = new ProductionLifecycleRouter({
      effects,
      persistence,
      repositoryRoot: blueprintRepository.repositoryRoot,
      sourceRef: blueprintRepository.sourceRef,
    });
    const consoleLifecycleActions: ConsoleLifecycleActionPort = {
      rebase: async (input) => {
        await lifecycle.rebase(input);
      },
    };
    const projects = new EpicProjectCoordinator(
      configuration,
      persistence,
      routing,
      t3,
      undefined,
      undefined,
      attention,
    );
    const sharedProject = new SharedProjectCoordinator(
      configuration,
      persistence,
      t3,
    );
    const instances = new ProductionInstanceController(
      configuration,
      persistence,
      lifecycle,
      routing,
      projects,
      attention,
      t3,
      options.workflowMcpEndpoint,
      resolveSystemPrompt,
      templateAuthority,
      async (instanceId, uses) => {
        const status = await lifecycle.boardStatusFor(instanceId, uses);
        if (status === undefined) return undefined;
        assertMechanicalBoardStatusConfigured(
          uses,
          status,
          await boardStatuses(),
        );
        return status;
      },
      (taskId, status) => board.mirrorTaskStatus(taskId, status),
      undefined,
      providerResolver,
    );
    const lifecycleAttentionBridge = new LifecycleAttentionBridge(
      persistence,
      attention,
    );
    const raiseNotificationDeliveryError = async (
      error: NotificationDeliveryError,
      page: OperatorPage,
    ): Promise<void> => {
      if (page.instanceId === undefined) throw error;
      const runtime = persistence!
        .listReconcilerRuntime()
        .find(({ instanceId }) => instanceId === page.instanceId);
      if (runtime === undefined) throw error;
      const failure = notificationDeliveryErrorAttention({
        error,
        instanceId: page.instanceId,
        stableId: page.attentionId,
        taskId: runtime.taskId,
      });
      await attention.raiseCurrentNotificationFailure(failure);
    };
    const escalation = new EscalationCoordinator({
      attention: {
        raise: async (value) => {
          await attention.raise(value);
          await options.afterEscalationEffect?.("attention", value.attentionId);
        },
      },
      containPushoverFailure: async (error, opened) => {
        if (!(error instanceof NotificationDeliveryError)) return false;
        await raiseNotificationDeliveryError(error, {
          attentionId: opened.attentionId,
          instanceId: opened.instanceId,
          message: `Heddle escalation in ${opened.stage}`,
        });
        return true;
      },
      parent: {
        steer: async (pending: ParentEscalation) => {
          const binding = productionSessionBindingFor(
            persistence!,
            pending.parentSessionKey,
          );
          await steerStageSession(
            {
              interactionMode: binding.interactionMode,
              message: `Child escalation ${pending.attentionId} requires an answer`,
              providerContext: providerContextFromBinding(binding),
              runtimeMode: binding.runtimeMode,
              threadId: binding.threadId,
            },
            { t3 },
          );
        },
      },
      persistence,
      pushover: {
        send: async (value) => {
          await sendNotification({
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
      providerResolver,
      resolveSystemPrompt,
      t3,
      templateAuthority,
      workflowMcpEndpoint: options.workflowMcpEndpoint,
    });
    subagents = coordinator;
    const incidents = new ProductionIncidentCoordinator(
      persistence,
      attention,
      lifecycle,
      instances,
      {
        secrets: [
          configuration.pushover.applicationToken,
          configuration.pushover.userKey,
          configuration.t3.accessToken,
        ],
      },
    );
    const consoleActions = new ProductionAttentionActions(
      persistence,
      attention,
      escalation,
      observer,
    );
    const reconciler = new Reconciler({
      attention,
      board,
      dynamicTasks,
      epicOperations,
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
      board: dynamicTasks,
      escalationCoordinator: escalation,
      lifecycle: incidents,
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
      const incident = persistence!
        .listIncidentRuntime()
        .find(({ incidentId }) => incidentId === session.instanceId);
      if (runtime === undefined && incident === undefined) throw error;
      const summary =
        code === "session-observation-failed"
          ? `Session ${session.sessionKey} observation failed`
          : `Session ${session.sessionKey} page delivery failed`;
      const taskId = runtime?.taskId ?? incident!.taskId;
      const failure =
        incident === undefined
          ? productionErrorAttention({
              code,
              error,
              instanceId: session.instanceId,
              summary,
              taskId,
            })
          : createProductionErrorAttention({
              attentionId: `production:incident-execution-failed:task:${taskId}:${incident.incidentId}`,
              code: "incident-execution-failed",
              error,
              instanceId: incident.incidentId,
              message: `Incident ${incident.incidentId} session failed`,
              taskId,
            });
      if (!(await attention.has(failure.attentionId))) {
        await attention.raise(failure);
      }
    };
    const scheduler = new ProductionScheduler({
      cadenceMilliseconds: configuration.cadenceMilliseconds,
      onError: async (error) => {
        try {
          await schedulerPassAttention.failure(error);
        } finally {
          await options.onSchedulerError?.(error);
        }
      },
      pass: async () => {
        await attention.replayProductionErrorPages();
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
        await incidents.reconcile(after);
        for (const session of productionSessionTargets(persistence!)) {
          const record = persistence!.getInstance(session.instanceId);
          if (
            record === undefined ||
            !isTodoState(record.state.todoState) ||
            !record.state.todoState.lists.some(
              (list) =>
                list.sessionKey === session.sessionKey ||
                (list.assignments ?? []).some(
                  ({ sessionKey }) => sessionKey === session.sessionKey,
                ),
            )
          ) {
            continue;
          }
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
            await pageSessionAttentions(
              observation.attentions,
              { send: sendNotification },
              async (error, page) => {
                if (!(error instanceof NotificationDeliveryError)) return false;
                await raiseNotificationDeliveryError(error, page);
                return true;
              },
            );
          } catch (error) {
            await raiseSessionProductionError(
              "session-page-delivery-failed",
              error,
              session,
            );
          }
        }
        await lifecycleAttentionBridge.flush();
        schedulerPassAttention.recovery();
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
      consoleBoard: {
        readBoard: () => board.readBoard(),
        readBoardStatuses: () => board.readBoardStatuses(),
        setEpicInProgress: (taskId, inProgress) =>
          epicOperations.run(taskId, () =>
            board.setEpicInProgress(taskId, inProgress),
          ),
      },
      consoleLifecycleActions,
      consoleState: new ProductionConsoleState(
        persistence,
        attention,
        blueprintRepository.repositoryRoot,
        blueprintRepository.sourceRef,
      ),
      dynamicTasks,
      escalation,
      instances,
      lifecycle,
      mcp,
      persistence,
      scheduler,
      subagents: coordinator,
      start: async () => {
        await dynamicTasks.recoverPending();
        await sharedProject.reconcile();
        await scheduler.start();
      },
      close: async () => {
        if (closed) return;
        try {
          await scheduler.stop();
        } finally {
          try {
            await mcp.close();
          } finally {
            persistence!.close();
            activeWorkspaces.delete(workspaceId);
            closed = true;
          }
        }
      },
    };
  } catch (error) {
    persistence?.close();
    activeWorkspaces.delete(workspaceId);
    throw error;
  }
};
