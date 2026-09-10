// ---
// relationships:
//   implements: heddle
// ---

import {
  HandoffRenderError,
  HandoffTemplateError,
  type ProviderSelectionResolver,
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
import {
  assertResolvedSessionBinding,
  type ResolvedSessionBinding,
  type SqlitePersistence,
} from "../persistence/index.js";
import {
  SubagentCoordinator,
  type DelegatedProviderExhaustionError,
} from "../subagents/index.js";
import { isTodoState, type TodoAssignment } from "../todo/index.js";
import { EscalationHistory } from "../mcp-server/escalation-history.js";
import { errorDetail } from "../error-details.js";
import type { ResolvedProductionConfiguration } from "./configuration.js";
import type { ProductionT3Client } from "./composition.js";
import type { KanbanBoardAdapter } from "../board-adapter/index.js";
import type { DurableAttentionQueue } from "./durable-adapters.js";
import { heddleSessionTitle } from "./session-title.js";
import { sanitizeIncidentValue } from "./incident-redaction.js";
import { stableUuid } from "./stable-uuid.js";
import { createProductionErrorAttention } from "./error-visibility.js";
import {
  bindResolvedSession,
  modelSelectionFromBinding,
  providerContextFromBinding,
} from "./session-binding.js";

const assignments = (persistence: SqlitePersistence): TodoAssignment[] =>
  persistence
    .listInstances()
    .flatMap(({ state }) =>
      isTodoState(state.todoState)
        ? state.todoState.lists.flatMap((list) => list.assignments ?? [])
        : [],
    );

const describeDelegatedExhaustion = (
  error: DelegatedProviderExhaustionError,
): string =>
  error.skippedCandidates
    .map(
      ({ candidatePosition, failure, modelSlug, providerDisplayName }) =>
        `candidate ${candidatePosition} (${providerDisplayName}/${modelSlug}): ${failure.reason}: ${failure.message}`,
    )
    .join("; ");

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

export const productionSessionBindingFor = (
  persistence: SqlitePersistence,
  sessionKey: string,
  threadId?: string,
): ResolvedSessionBinding => {
  const topLevelMatches = persistence
    .listSessionRuntime()
    .filter(
      (session) =>
        session.sessionKey === sessionKey &&
        (threadId === undefined || session.threadId === threadId),
    );
  const delegatedMatches = assignments(persistence).filter(
    (assignment) =>
      assignment.sessionKey === sessionKey &&
      (threadId === undefined || assignment.threadId === threadId),
  );
  if (topLevelMatches.length + delegatedMatches.length !== 1) {
    throw new Error("Session has no canonical resolved binding");
  }
  if (topLevelMatches.length === 1) {
    return topLevelMatches[0]!.binding;
  }
  return delegatedMatches[0]!.binding;
};

export const productionSessionTargets = (
  persistence: SqlitePersistence,
): SessionObservationTarget[] => {
  const topLevel = persistence.listSessionRuntime().map((session) => ({
    instanceId: session.instanceId,
    sessionKey: session.sessionKey,
    threadId: session.threadId,
  }));
  const history = new EscalationHistory(persistence);
  const children = persistence.listInstances().flatMap((instance) => {
    const questionSessions = new Set(
      history
        .pending(instance.instanceId)
        .flatMap((question) => [
          question.ownerSessionKey,
          ...(question.answeringAuthority.kind === "operator"
            ? []
            : [question.answeringAuthority.sessionKey]),
        ]),
    );
    return isTodoState(instance.state.todoState)
      ? instance.state.todoState.lists.flatMap((list) =>
          (list.assignments ?? [])
            .filter(
              ({ providerFallback, status, sessionKey }) =>
                (status === "active" && providerFallback === undefined) ||
                questionSessions.has(sessionKey),
            )
            .map((assignment) => ({
              instanceId: instance.instanceId,
              sessionKey: assignment.sessionKey,
              threadId: assignment.threadId,
            })),
        )
      : [];
  });
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

export const productionActiveSessions = async (
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
      .map(({ binding, sessionKey }) => ({
        depth: 0,
        provider: binding.providerInstanceId,
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
  configuration: ResolvedProductionConfiguration;
  observer: SessionObserver;
  pacing: DispatchPacingEvaluator;
  persistence: SqlitePersistence;
  providerResolver: ProviderSelectionResolver;
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
    providerResolver,
    resolveSystemPrompt,
    t3,
    templateAuthority,
    workflowMcpEndpoint,
  } = options;
  const resolveCandidates = async (input: {
    alias: string;
    runtimeMode: ResolvedSessionBinding["runtimeMode"];
    sessionKey: string;
  }) =>
    (
      await providerResolver.resolveCandidates(input.alias, {
        interactionMode: configuration.session.interactionMode,
        runtimeMode: input.runtimeMode,
      })
    ).map((candidate) => ({
      binding: bindResolvedSession(
        candidate,
        input.sessionKey,
        stableUuid(
          `${input.sessionKey}:candidate:${candidate.candidatePosition}:thread`,
        ),
      ),
      catalogFailures: candidate.catalogFailures,
    }));
  return new SubagentCoordinator({
    activeSessions: () => productionActiveSessions(persistence, t3),
    bootstrapDependencies: {
      activationEvents: persistence,
      persistence,
      resolveSystemPrompt,
      templateAuthority,
      t3: {
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
    onProviderExhaustion: async ({
      binding,
      error,
      operationId,
      sessionKey,
    }) => {
      const taskId = persistence
        .listReconcilerRuntime()
        .find(
          ({ instanceId }) => instanceId === binding.instance.instanceId,
        )?.taskId;
      const exhausted = createProductionErrorAttention({
        attentionId: `production:provider-alias-exhausted:subagent:${stableUuid(
          `${binding.instance.instanceId}:${sessionKey}:${operationId}`,
        )}`,
        code: error.reason,
        error,
        instanceId: binding.instance.instanceId,
        message: `Provider alias '${error.alias}' exhausted every delegated candidate: ${describeDelegatedExhaustion(error)}`,
        ...(taskId === undefined ? {} : { taskId }),
      });
      if (!(await attention.has(exhausted.attentionId))) {
        await attention.raise(exhausted);
      } else {
        attention.reopen(exhausted.attentionId);
      }
    },
    providerFailureDetail: (error, binding) =>
      sanitizeIncidentValue(errorDetail(error), [
        configuration.pushover?.applicationToken ?? "",
        configuration.pushover?.userKey ?? "",
        configuration.t3?.accessToken ?? "",
        ...persistence
          .listInstances()
          .flatMap(({ state }) => Object.values(state.correlationTokens)),
        binding.sessionKey,
      ]) as ReturnType<typeof errorDetail>,
    pacing,
    persistence,
    providerSelection: {
      list: () =>
        providerResolver.listAllowed(
          {
            interactionMode: configuration.session.interactionMode,
            runtimeMode: configuration.session.defaultRuntimeMode,
          },
          configuration.session.resolvedSelections,
        ),
      resolve: async ({ alias, runtimeMode, sessionKey, threadId }) => {
        const [candidate] = await resolveCandidates({
          alias,
          runtimeMode,
          sessionKey,
        });
        return {
          ...candidate!.binding,
          threadId,
        };
      },
      resolveCandidates: ({ alias, runtimeMode, sessionKey }) =>
        resolveCandidates({ alias, runtimeMode, sessionKey }),
      runtimeModeFor: async (sessionKey) =>
        productionSessionBindingFor(persistence, sessionKey).runtimeMode,
    },
    prepareSession: async ({ binding, identity, resolvedBinding }) => {
      const runtimes = persistence
        .listReconcilerRuntime()
        .filter(({ instanceId }) => instanceId === binding.instance.instanceId);
      if (runtimes.length !== 1) {
        throw new Error("Subagent parent has no canonical reconciler runtime");
      }
      const taskId = runtimes[0]!.taskId;
      const task = await board.readTask(taskId);
      const session = configuration.session;
      const sessionBinding =
        resolvedBinding ??
        (() => {
          throw new Error("Subagent provider selection was not resolved");
        })();
      assertResolvedSessionBinding(
        sessionBinding,
        identity.sessionKey,
        identity.threadId,
      );
      const route = parentSessionRoute(persistence, binding.sessionKey);
      const repository = configuration.products
        .flatMap(({ repos }) => repos)
        .find(({ name }) => name === route.repositoryName);
      if (repository === undefined) {
        throw new Error("Subagent parent repository is not configured");
      }
      return {
        binding: sessionBinding,
        interactionMode: sessionBinding.interactionMode,
        modelSelection: modelSelectionFromBinding(sessionBinding),
        projectId: route.projectId,
        providerContext: providerContextFromBinding(sessionBinding),
        runtimeMode: sessionBinding.runtimeMode,
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
      const binding = productionSessionBindingFor(
        persistence,
        assignment.parentSessionKey,
        assignment.parentThreadId,
      );
      await steerStageSession(
        {
          commandId: notice.commandId,
          createdAt: notice.createdAt,
          interactionMode: binding.interactionMode,
          message,
          messageId: notice.messageId,
          providerContext: providerContextFromBinding(binding),
          runtimeMode: binding.runtimeMode,
          threadId: assignment.parentThreadId,
        },
        { t3 },
      );
    },
  });
};
