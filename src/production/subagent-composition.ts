// ---
// relationships:
//   implements: heddle
// ---

import {
  HandoffRenderError,
  HandoffTemplateError,
  type SessionObservationTarget,
  type SessionObserver,
  type SessionTemplateAuthority,
  type SystemPromptResolver,
  steerStageSession,
} from "../control-plane/index.js";
import { resolveT3AwarenessPhase } from "../control-plane/t3-agent-awareness.js";
import type {
  DispatchPacingEvaluator,
  PacingSession,
} from "../pacing/index.js";
import type { SqlitePersistence } from "../persistence/index.js";
import { SubagentCoordinator } from "../subagents/index.js";
import { isTodoState, type TodoAssignment } from "../todo/index.js";
import type { ProductionConfiguration } from "./configuration.js";
import type { ProductionT3Client } from "./composition.js";
import type { KanbanBoardAdapter } from "../board-adapter/index.js";
import type { DurableAttentionQueue } from "./durable-adapters.js";
import { heddleSessionTitle } from "./session-title.js";

const assignments = (persistence: SqlitePersistence): TodoAssignment[] =>
  persistence
    .listInstances()
    .flatMap(({ state }) =>
      isTodoState(state.todoState)
        ? state.todoState.lists.flatMap((list) => list.assignments ?? [])
        : [],
    );

const parentSessionRoute = (
  persistence: SqlitePersistence,
  sessionKey: string,
): { projectId: string; repositoryName: string } => {
  const sessions = new Map(
    persistence
      .listSessionRuntime()
      .map((session) => [session.sessionKey, session]),
  );
  const delegated = new Map(
    assignments(persistence).map((assignment) => [
      assignment.sessionKey,
      assignment,
    ]),
  );
  let current = sessionKey;
  const visited = new Set<string>();
  while (!visited.has(current)) {
    visited.add(current);
    const session = sessions.get(current);
    if (session !== undefined) {
      if (
        session.projectId === undefined ||
        session.repositoryName === undefined
      ) {
        throw new Error("Subagent parent has no durable production route");
      }
      return {
        projectId: session.projectId,
        repositoryName: session.repositoryName,
      };
    }
    const assignment = delegated.get(current);
    if (assignment === undefined) break;
    current = assignment.parentSessionKey;
  }
  throw new Error("Subagent parent has no canonical production route");
};

const uniqueTarget = (
  targets: SessionObservationTarget[],
  sessionKey: string,
): SessionObservationTarget => {
  const matches = targets.filter((target) => target.sessionKey === sessionKey);
  if (matches.length !== 1) {
    throw new Error(
      `Session '${sessionKey}' does not have one canonical production target`,
    );
  }
  return matches[0]!;
};

export const productionSessionTargets = (
  persistence: SqlitePersistence,
): SessionObservationTarget[] => {
  const topLevel = persistence.listSessionRuntime().map((session) => ({
    instanceId: session.instanceId,
    sessionKey: session.sessionKey,
    threadId: session.threadId,
  }));
  const children = persistence.listInstances().flatMap((instance) =>
    isTodoState(instance.state.todoState)
      ? instance.state.todoState.lists.flatMap((list) =>
          (list.assignments ?? [])
            .filter(({ status }) => status === "active")
            .map((assignment) => ({
              instanceId: instance.instanceId,
              sessionKey: assignment.sessionKey,
              threadId: assignment.threadId,
            })),
        )
      : [],
  );
  const targets = [...topLevel, ...children];
  const sessionKeys = new Set<string>();
  const threadIds = new Set<string>();
  for (const target of targets) {
    if (sessionKeys.has(target.sessionKey) || threadIds.has(target.threadId)) {
      throw new Error("Production session identities are not globally unique");
    }
    sessionKeys.add(target.sessionKey);
    threadIds.add(target.threadId);
  }
  return targets;
};

const activeSessions = async (
  configuration: ProductionConfiguration,
  persistence: SqlitePersistence,
  t3: ProductionT3Client,
): Promise<PacingSession[]> => {
  const activePhases = new Set([
    "running",
    "starting",
    "waiting_for_approval",
    "waiting_for_input",
  ]);
  const activeThreadIds = new Set(
    (await t3.getShell()).threads
      .filter((thread) => activePhases.has(resolveT3AwarenessPhase(thread)))
      .map(({ id }) => id),
  );
  return [
    ...persistence
      .listSessionRuntime()
      .filter(({ threadId }) => activeThreadIds.has(threadId))
      .map(({ sessionKey }) => ({
        depth: 0,
        provider: configuration.session.driver,
        sessionId: sessionKey,
      })),
    ...assignments(persistence)
      .filter(
        ({ status, threadId }) =>
          status === "active" && activeThreadIds.has(threadId),
      )
      .map((assignment) => ({
        depth: assignment.depth,
        parentSessionId: assignment.parentSessionKey,
        provider: assignment.provider,
        sessionId: assignment.sessionKey,
      })),
  ];
};

export const createProductionSubagentCoordinator = (options: {
  attention: DurableAttentionQueue;
  board: Pick<KanbanBoardAdapter, "readTask">;
  configuration: ProductionConfiguration;
  observer: SessionObserver;
  pacing: DispatchPacingEvaluator;
  persistence: SqlitePersistence;
  resolveSystemPrompt: SystemPromptResolver;
  t3: ProductionT3Client;
  templateAuthority: SessionTemplateAuthority;
  workflowMcpEndpoint: string;
}): SubagentCoordinator => {
  const {
    attention,
    board,
    configuration,
    observer,
    pacing,
    persistence,
    resolveSystemPrompt,
    t3,
    templateAuthority,
    workflowMcpEndpoint,
  } = options;
  return new SubagentCoordinator({
    activeSessions: () => activeSessions(configuration, persistence, t3),
    bootstrapDependencies: {
      activationEvents: persistence,
      persistence,
      resolveSystemPrompt,
      templateAuthority,
      t3: {
        ...(t3.applyHarnessToolTimeout === undefined
          ? {}
          : {
              applyHarnessToolTimeout: (input) =>
                t3.applyHarnessToolTimeout!(input),
            }),
        dispatch: (command, providerContext) =>
          t3.dispatch(command, providerContext),
        registerWorkflowMcpProviderSession: (registration) =>
          t3.registerWorkflowMcpProviderSession(registration),
      },
      workflowMcpEndpoint,
    },
    observeChild: (target) => observer.observe(target),
    onBootstrapFailure: async ({ error, instanceId, sessionKey, taskId }) => {
      if (
        !(error instanceof HandoffRenderError) &&
        !(error instanceof HandoffTemplateError)
      ) {
        return;
      }
      const attentionId = `${sessionKey}:handoff-render`;
      if (!(await attention.has(attentionId))) {
        await attention.raise({
          attentionId,
          code: "handoff-render-failed",
          instanceId,
          kind: "lifecycle-resolution",
          message: error.message,
          taskId,
        });
      }
    },
    pacing,
    persistence,
    prepareSession: async ({ binding, identity, model, provider }) => {
      const runtimes = persistence
        .listReconcilerRuntime()
        .filter(({ instanceId }) => instanceId === binding.instance.instanceId);
      if (runtimes.length !== 1) {
        throw new Error("Subagent parent has no canonical reconciler runtime");
      }
      const taskId = runtimes[0]!.taskId;
      const task = await board.readTask(taskId);
      const session = configuration.session;
      const route = parentSessionRoute(persistence, binding.sessionKey);
      const repository = configuration.products
        .flatMap(({ repos }) => repos)
        .find(({ name }) => name === route.repositoryName);
      if (repository === undefined) {
        throw new Error("Subagent parent repository is not configured");
      }
      return {
        interactionMode: session.interactionMode,
        modelSelection: { instanceId: provider, model },
        projectId: route.projectId,
        providerContext: {
          cliVersion: session.cliVersion,
          driver: provider,
          lifecycle: "independent",
        },
        runtimeMode: session.runtimeMode,
        task: task.frontMatter,
        taskId,
        title: heddleSessionTitle(
          taskId,
          `${binding.stage.id}-subagent-${identity.sessionKey.slice(0, 8)}`,
        ),
        worktree: {
          baseRef: session.baseRef,
          branch: `heddle/task-${taskId}`,
          repositoryName: repository.name,
          repositoryRoot: repository.repositoryRoot,
          worktreeName: String(taskId),
          ...(session.worktreesRoot === undefined
            ? {}
            : { worktreesRoot: session.worktreesRoot }),
        },
      };
    },
    sessionTargetFor: (binding) => {
      const target = uniqueTarget(
        productionSessionTargets(persistence),
        binding.sessionKey,
      );
      if (target.instanceId !== binding.instance.instanceId) {
        throw new Error("Subagent parent target changed instance identity");
      }
      return target;
    },
    steerParent: async ({ assignment, message }) => {
      const notice = assignment.stopNotification;
      if (notice === undefined) {
        throw new Error("Subagent stop has no durable notification intent");
      }
      const session = configuration.session;
      await steerStageSession(
        {
          commandId: notice.commandId,
          createdAt: notice.createdAt,
          interactionMode: session.interactionMode,
          message,
          messageId: notice.messageId,
          providerContext: {
            cliVersion: session.cliVersion,
            driver: assignment.provider,
            lifecycle: "independent",
          },
          runtimeMode: session.runtimeMode,
          threadId: assignment.parentThreadId,
        },
        { t3 },
      );
    },
  });
};
