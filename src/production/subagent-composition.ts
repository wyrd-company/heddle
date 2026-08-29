// ---
// relationships:
//   implements: heddle
// ---

import {
  type SessionObservationTarget,
  type SessionObserver,
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
import { heddleSessionTitle } from "./session-title.js";

const assignments = (persistence: SqlitePersistence): TodoAssignment[] =>
  persistence
    .listInstances()
    .flatMap(({ state }) =>
      isTodoState(state.todoState)
        ? state.todoState.lists.flatMap((list) => list.assignments ?? [])
        : [],
    );

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
  configuration: ProductionConfiguration;
  observer: SessionObserver;
  pacing: DispatchPacingEvaluator;
  persistence: SqlitePersistence;
  t3: ProductionT3Client;
}): SubagentCoordinator => {
  const { configuration, observer, pacing, persistence, t3 } = options;
  return new SubagentCoordinator({
    activeSessions: () => activeSessions(configuration, persistence, t3),
    bootstrapDependencies: {
      persistence,
      t3: {
        ...(t3.applyHarnessToolTimeout === undefined
          ? {}
          : {
              applyHarnessToolTimeout: (input) =>
                t3.applyHarnessToolTimeout!(input),
            }),
        dispatch: (command, providerContext) =>
          t3.dispatch(command, providerContext),
      },
    },
    observeChild: (target) => observer.observe(target),
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
      const session = configuration.session;
      return {
        interactionMode: session.interactionMode,
        modelSelection: { instanceId: provider, model },
        projectId: configuration.projectId,
        providerContext: {
          cliVersion: session.cliVersion,
          driver: provider,
          lifecycle: "independent",
        },
        runtimeMode: session.runtimeMode,
        title: heddleSessionTitle(
          taskId,
          `${binding.stage.id}-subagent-${identity.sessionKey.slice(0, 8)}`,
        ),
        worktree: {
          baseRef: session.baseRef,
          branch: `heddle/task-${taskId}`,
          repositoryName: session.repositoryName,
          repositoryRoot: configuration.repositoryRoot,
          worktreeName: `task-${taskId}`,
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
