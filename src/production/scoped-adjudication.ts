// ---
// relationships:
//   implements: heddle
// ---

import type { BoardTask, KanbanBoardAdapter } from "../board-adapter/index.js";
import { ensureCorrelationToken } from "../control-plane/correlation-token.js";
import { resolveT3AwarenessPhase } from "../control-plane/t3-agent-awareness.js";
import type {
  AdjudicationEscalationRouter,
  PendingEscalation,
} from "../mcp-server/index.js";
import type {
  JsonValue,
  ProviderCandidateFailureDetail,
  ResolvedSessionBinding,
  SessionRuntimeRecord,
  SkippedProviderCandidate,
  SqlitePersistence,
} from "../persistence/index.js";
import type { DispatchPacingEvaluator } from "../pacing/index.js";
import { errorDetail } from "../error-details.js";
import { sanitizeIncidentValue } from "./incident-redaction.js";
import type { ResolvedProductionConfiguration } from "./configuration.js";
import type { ProductionT3Client } from "./composition.js";
import {
  bindResolvedSession,
  modelSelectionFromBinding,
  providerContextFromBinding,
} from "./session-binding.js";
import { StartupProviderSelectionResolver } from "./stage-session-selection.js";
import { stableUuid } from "./stable-uuid.js";
import { productionActiveSessions } from "./subagent-composition.js";
import {
  readPinnedAdjudicationPolicy,
  renderAdjudicationBoundary,
  type PinnedAdjudicationPolicy,
} from "./adjudication-policy.js";
import { readProductionHandoffStage } from "./stage-handoff.js";

type AdjudicationAuthority = Extract<
  PendingEscalation["answeringAuthority"],
  { kind: "adjudication" }
>;

type AdjudicationEscalation = PendingEscalation & {
  answeringAuthority: AdjudicationAuthority;
};

const taskSummary = (task: BoardTask) => ({
  blocked: task.blocked,
  dependencies: [...task.dependencies],
  id: task.id,
  parent: task.parent ?? null,
  priority: task.priority,
  status: task.status,
  tags: [...task.tags],
  title: task.title,
});

const asRecord = (value: JsonValue): Record<string, JsonValue> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;

const storedAdjudication = (
  handoff: JsonValue,
  sessionKey: string,
): boolean => {
  const record = asRecord(handoff);
  return (
    record?.["kind"] === "adjudication-handoff" &&
    record["sessionKey"] === sessionKey
  );
};

const renderPrompt = (input: {
  context: JsonValue;
  policy: PinnedAdjudicationPolicy;
}): string =>
  [
    "# Scoped escalation adjudication",
    "",
    "You have authority only to answer the bound escalation or decline it to the operator.",
    "Use `answer` with every offered question ID and include your reasoning in `prose`.",
    "Use `decline` with a concise reason and reasoning when the decision belongs to the operator.",
    "Do not change board state, tasks, repositories, service configuration, or start another session.",
    "Do not request approval or user input. Finish after one tool call.",
    "",
    renderAdjudicationBoundary(input.policy.policy),
    "",
    "## Current epic context",
    "",
    "```json",
    JSON.stringify(input.context, null, 2),
    "```",
  ].join("\n");

const failureDetail = (
  error: unknown,
  secrets: readonly string[],
): ProviderCandidateFailureDetail =>
  sanitizeIncidentValue(
    errorDetail(error),
    secrets,
  ) as ProviderCandidateFailureDetail;

export class ProductionScopedAdjudication implements AdjudicationEscalationRouter {
  public constructor(
    private readonly options: {
      board: Pick<KanbanBoardAdapter, "readBoard">;
      blueprintRepository: { repositoryRoot: string; sourceRef: string };
      configuration: ResolvedProductionConfiguration;
      pacing: DispatchPacingEvaluator;
      persistence: SqlitePersistence;
      t3: ProductionT3Client;
      workflowMcpEndpoint: string;
      now?: () => number;
    },
  ) {}

  async start(opened: AdjudicationEscalation): Promise<{ modelSlug: string }> {
    const existing = this.#runtime(opened.answeringAuthority.sessionKey);
    if (existing !== undefined && existing.bindingState !== "provisional") {
      return { modelSlug: existing.binding.modelSlug };
    }
    const configuration = this.options.configuration.adjudication;
    if (configuration === undefined) {
      throw new Error("Adjudication is not configured");
    }
    const policy = await readPinnedAdjudicationPolicy({
      path: configuration.policyPath,
      repositoryRoot: this.options.blueprintRepository.repositoryRoot,
      sourceRef: this.options.blueprintRepository.sourceRef,
    });
    const route = await this.#route(opened);
    const context = await this.#context(opened, route.task, policy);
    const prompt = renderPrompt({ context, policy });
    const { token } = ensureCorrelationToken(
      this.options.persistence,
      opened.instanceId,
      opened.answeringAuthority.sessionKey,
    );
    const configuredCandidates = await new StartupProviderSelectionResolver(
      this.options.configuration.session.resolvedSelections,
    ).resolveCandidates(configuration.providerAlias, {
      interactionMode: this.options.configuration.session.interactionMode,
      runtimeMode: "approval-required",
    });
    const skipped: SkippedProviderCandidate[] = [
      ...(existing?.binding.skippedCandidates ?? []),
    ];
    const firstIndex = existing?.binding.candidatePosition ?? 0;
    if (existing !== undefined) {
      const recovered = await this.#recoverStarted(existing);
      if (recovered) return { modelSlug: existing.binding.modelSlug };
      if (
        !skipped.some(
          ({ candidatePosition }) => candidatePosition === firstIndex,
        )
      ) {
        skipped.push(
          this.#skipped(
            existing.binding,
            new Error("The candidate did not start"),
          ),
        );
      }
    }
    for (
      let index = firstIndex;
      index < configuredCandidates.length;
      index += 1
    ) {
      const selection = configuredCandidates[index]!;
      const candidatePosition = index + 1;
      const threadId = stableUuid(
        `${opened.answeringAuthority.sessionKey}:candidate:${candidatePosition}:thread`,
      );
      const binding = bindResolvedSession(
        selection,
        opened.answeringAuthority.sessionKey,
        threadId,
        candidatePosition,
        skipped,
      );
      const pacing = await this.options.pacing.evaluate(
        {
          kind: "task",
          provider: binding.providerInstanceId,
          sessionId: binding.sessionKey,
        },
        await productionActiveSessions(
          this.options.persistence,
          this.options.t3,
        ),
      );
      if (pacing.kind === "defer") {
        throw new Error(
          `Adjudication pacing denied dispatch: ${pacing.deferral.reason}`,
        );
      }
      const runtime: SessionRuntimeRecord = {
        activation:
          Number.parseInt(
            opened.attentionId.slice("escalation:".length).slice(0, 12),
            16,
          ) + 1,
        binding,
        bindingState: "provisional",
        instanceId: opened.instanceId,
        projectId: route.projectId,
        repositoryName: route.repositoryName,
        sessionKey: binding.sessionKey,
        stageId: "adjudication",
        threadId,
      };
      this.options.persistence.writeSessionRuntime(runtime);
      this.#storeHandoff(opened, binding, token, prompt, context, policy);
      try {
        await this.options.t3.registerWorkflowMcpProviderSession({
          authorizationHeader: `Bearer ${token}`,
          endpoint: this.options.workflowMcpEndpoint,
          threadId,
        });
        await this.options.t3.dispatch({
          branch: `heddle/task-${route.task.id}`,
          commandId: stableUuid(`${threadId}:create`),
          createdAt: new Date(this.#now()).toISOString(),
          interactionMode: binding.interactionMode,
          modelSelection: modelSelectionFromBinding(binding),
          projectId: route.projectId,
          runtimeMode: binding.runtimeMode,
          threadId,
          title: `task-${route.task.id} · adjudication`,
          type: "thread.create",
          worktreePath: route.worktreePath,
        });
        await this.options.t3.dispatch(
          {
            commandId: stableUuid(`${threadId}:turn`),
            createdAt: new Date(this.#now()).toISOString(),
            interactionMode: binding.interactionMode,
            message: {
              attachments: [],
              messageId: stableUuid(`${threadId}:message`),
              role: "user",
              text: prompt,
            },
            modelSelection: modelSelectionFromBinding(binding),
            runtimeMode: binding.runtimeMode,
            threadId,
            type: "thread.turn.start",
          },
          providerContextFromBinding(binding),
        );
        this.options.persistence.confirmSessionBindingStarted(
          runtime.sessionKey,
          runtime.threadId,
        );
        return { modelSlug: binding.modelSlug };
      } catch (error) {
        skipped.push(this.#skipped(binding, error));
      }
    }
    throw new Error(
      `Adjudication provider alias '${configuration.providerAlias}' exhausted every candidate: ${skipped.map(({ failure }) => failure.message).join("; ")}`,
    );
  }

  async stop(input: {
    reason: "answered" | "declined" | "failed";
    sessionKey: string;
  }): Promise<void> {
    const runtime = this.#runtime(input.sessionKey);
    if (runtime === undefined) return;
    const thread = (await this.options.t3.getShell()).threads.find(
      ({ id }) => id === runtime.threadId,
    );
    if (
      thread === undefined ||
      ["completed", "failed"].includes(resolveT3AwarenessPhase(thread))
    ) {
      return;
    }
    await this.options.t3.dispatch({
      commandId: stableUuid(`${runtime.threadId}:stop:${input.reason}`),
      createdAt: new Date(this.#now()).toISOString(),
      threadId: runtime.threadId,
      type: "thread.session.stop",
    });
  }

  isAdjudicationSession(sessionKey: string): boolean {
    return this.#runtime(sessionKey)?.stageId === "adjudication";
  }

  async observationFailure(sessionKey: string): Promise<string | undefined> {
    const runtime = this.#runtime(sessionKey);
    if (runtime?.stageId !== "adjudication") return undefined;
    const thread = (await this.options.t3.getShell()).threads.find(
      ({ id }) => id === runtime.threadId,
    );
    if (thread === undefined) return "Adjudication session is absent";
    if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
      return "Adjudication attempted operator interaction outside its authority";
    }
    const phase = resolveT3AwarenessPhase(thread);
    if (phase === "failed" || phase === "completed") {
      return `Adjudication session ${phase} without deciding`;
    }
    const requestedAt = thread.latestTurn?.requestedAt;
    if (requestedAt !== null && requestedAt !== undefined) {
      const stored = this.options.persistence
        .getInstance(runtime.instanceId)
        ?.state.handoffs.map((candidate) => asRecord(candidate))
        .find(
          (candidate) =>
            candidate?.["kind"] === "adjudication-handoff" &&
            candidate["sessionKey"] === sessionKey,
        );
      const timeoutMilliseconds = stored?.["timeoutMilliseconds"];
      if (typeof timeoutMilliseconds !== "number") {
        return "Adjudication has no pinned time budget";
      }
      if (this.#now() - Date.parse(requestedAt) > timeoutMilliseconds) {
        return "Adjudication exceeded its time budget";
      }
    }
    return undefined;
  }

  #runtime(sessionKey: string): SessionRuntimeRecord | undefined {
    return this.options.persistence
      .listSessionRuntime()
      .find((runtime) => runtime.sessionKey === sessionKey);
  }

  #now(): number {
    return (this.options.now ?? Date.now)();
  }

  async #recoverStarted(runtime: SessionRuntimeRecord): Promise<boolean> {
    const thread = (await this.options.t3.getShell()).threads.find(
      ({ id }) => id === runtime.threadId,
    );
    if (thread === undefined || resolveT3AwarenessPhase(thread) === "failed") {
      return false;
    }
    if (resolveT3AwarenessPhase(thread) === "none") return false;
    this.options.persistence.confirmSessionBindingStarted(
      runtime.sessionKey,
      runtime.threadId,
    );
    return true;
  }

  #skipped(
    binding: ResolvedSessionBinding,
    error: unknown,
  ): SkippedProviderCandidate {
    const tokens = this.options.persistence
      .listInstances()
      .flatMap(({ state }) => Object.values(state.correlationTokens));
    return {
      candidatePosition: binding.candidatePosition,
      failure: failureDetail(error, [
        this.options.configuration.pushover.applicationToken,
        this.options.configuration.pushover.userKey,
        this.options.configuration.t3.accessToken,
        ...tokens,
      ]),
      modelSlug: binding.modelSlug,
      providerDisplayName: binding.providerDisplayName,
    };
  }

  async #route(opened: AdjudicationEscalation): Promise<{
    projectId: string;
    repositoryName: string;
    task: BoardTask;
    worktreePath: string;
  }> {
    const owner = this.options.persistence
      .listSessionRuntime()
      .find(({ sessionKey }) => sessionKey === opened.ownerSessionKey);
    const runtime = this.options.persistence
      .listReconcilerRuntime()
      .find(({ instanceId }) => instanceId === opened.instanceId);
    if (
      owner === undefined ||
      runtime === undefined ||
      owner.projectId === undefined ||
      owner.repositoryName === undefined
    ) {
      throw new Error("Escalation has no adjudication production route");
    }
    const board = await this.options.board.readBoard();
    const task = board.find(({ id }) => id === runtime.taskId);
    if (task === undefined)
      throw new Error("Escalation task is absent from the board");
    return {
      projectId: owner.projectId,
      repositoryName: owner.repositoryName,
      task,
      worktreePath: `${this.options.configuration.session.worktreesRoot ?? "/workspaces/worktrees"}/${task.id}/${owner.repositoryName}`,
    };
  }

  async #context(
    opened: AdjudicationEscalation,
    task: BoardTask,
    policy: PinnedAdjudicationPolicy,
  ): Promise<JsonValue> {
    const board = await this.options.board.readBoard();
    const epicId = task.parent ?? task.id;
    const epic = board.find(({ id }) => id === epicId);
    if (epic === undefined)
      throw new Error("Escalation epic is absent from the board");
    const prior = await readProductionHandoffStage({
      instanceId: opened.instanceId,
      persistence: this.options.persistence,
      repositoryRoot: this.options.blueprintRepository.repositoryRoot,
      stageId: opened.stage,
    });
    return {
      epic: taskSummary(epic),
      children: board
        .filter(({ parent }) => parent === epicId)
        .sort((left, right) => left.id - right.id)
        .map(taskSummary),
      escalation: {
        id: opened.escalationId,
        instanceId: opened.instanceId,
        ownerSessionKey: opened.ownerSessionKey,
        questions: opened.questions,
        stage: opened.stage,
      },
      policy: { blobHash: policy.blobHash, path: policy.path },
      priorStageOutputs:
        "priorStageOutputs" in prior.handoff
          ? prior.handoff.priorStageOutputs
          : [prior.handoff.review],
    };
  }

  #storeHandoff(
    opened: AdjudicationEscalation,
    binding: ResolvedSessionBinding,
    token: string,
    prompt: string,
    context: JsonValue,
    policy: PinnedAdjudicationPolicy,
  ): void {
    while (true) {
      const current = this.options.persistence.getInstance(opened.instanceId);
      if (current === undefined)
        throw new Error("Escalation instance is absent");
      const handoff = JSON.stringify({
        context,
        decisionBoundary: renderAdjudicationBoundary(policy.policy),
        format: "heddle.adjudication-handoff",
        policy: {
          blobHash: policy.blobHash,
          path: policy.path,
          timeoutMilliseconds: policy.policy.limits.timeoutMilliseconds,
        },
        version: 1,
      });
      const stored = {
        correlationToken: token,
        escalationId: opened.escalationId,
        handoff,
        kind: "adjudication-handoff",
        modelSlug: binding.modelSlug,
        ownerSessionKey: opened.ownerSessionKey,
        renderedHandoff: prompt,
        sessionKey: binding.sessionKey,
        timeoutMilliseconds: policy.policy.limits.timeoutMilliseconds,
      } as const;
      const claimed = this.options.persistence.compareAndSwapInstance(
        opened.instanceId,
        current.version,
        {
          ...current.state,
          handoffs: [
            ...current.state.handoffs.filter(
              (candidate) => !storedAdjudication(candidate, binding.sessionKey),
            ),
            stored,
          ],
        },
      );
      if (claimed !== undefined) return;
    }
  }
}
