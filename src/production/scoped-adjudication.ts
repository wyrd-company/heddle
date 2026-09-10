// ---
// relationships:
//   implements: heddle
// ---

import type { BoardTask, KanbanBoardAdapter } from "../board-adapter/index.js";
import { EscalationHistory } from "../mcp-server/escalation-history.js";
import { ensureCorrelationToken } from "../control-plane/correlation-token.js";
import { pendingRequestActivitiesFor } from "../control-plane/session-observation-attention.js";
import type { T3ThreadActivity } from "../control-plane/t3-control-plane-client.js";
import { resolveT3AwarenessPhase } from "../control-plane/t3-agent-awareness.js";
import type {
  AdjudicationEscalationRouter,
  PendingEscalation,
} from "../mcp-server/index.js";
import {
  isStoredAdjudicationHandoff,
  parseAdjudicationHandoff,
} from "../mcp-server/session-binding.js";
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
import {
  defaultApprovalSettlementMilliseconds,
  type ResolvedProductionConfiguration,
} from "./configuration.js";
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
  readAdjudicationPolicyBlob,
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

/** What a scheduler pass should do about an adjudication's pending approvals. */
export type AdjudicationApprovalOutcome =
  | { kind: "none" }
  | { kind: "deferred" }
  | { kind: "abandoned"; cause: string };

type AdjudicationActivation = {
  context: JsonValue;
  policy: PinnedAdjudicationPolicy;
  prompt: string;
};

/**
 * The name our T3 Code fork reports for an externally-registered MCP server.
 * Heddle registers exactly one such server per adjudication session and
 * declares the tools it exposes (`answer` and `decline`), so a request that
 * reports this server is a request to run one of those sanctioned tools.
 */
const sanctionedToolServer = "external";

const sanctionedToolApproval = (activity: T3ThreadActivity): boolean => {
  const payload = activity.payload;
  if (typeof payload !== "object" || payload === null) return false;
  const record = payload as Record<string, unknown>;
  return (
    record["requestKind"] === "mcp-elicitation" &&
    record["appName"] === sanctionedToolServer
  );
};

/**
 * Whether a request is still inside the settlement bound, measured from when
 * the control plane recorded the request.
 *
 * A request whose age cannot be read is treated as outside the bound, so an
 * unreadable timestamp fails closed rather than deferring observation forever.
 */
const withinSettlementBound = (
  activity: T3ThreadActivity,
  now: number,
  boundMilliseconds: number,
): boolean => {
  const createdAt = activity["createdAt"];
  if (typeof createdAt !== "string") return false;
  const requestedAt = Date.parse(createdAt);
  if (Number.isNaN(requestedAt)) return false;
  return now - requestedAt <= boundMilliseconds;
};

const isT3PreconditionError = (error: unknown): boolean =>
  error instanceof Error && error.name === "T3PreconditionError";

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
    "Use `answer` with every question ID. Each answer requires selectedOptions (offered labels), text, and reasoning. Supply either selected options or text, never both. Respect multiSelect; zero options requires text.",
    "Use `decline` with a concise reason and reasoning when the decision belongs to the operator.",
    "Do not change board state, tasks, repositories, service configuration, or start another session.",
    "Finish through the approved answer or decline tool. Do not stop while you owe an answer. If you need clarification, use the harness question tool and wait for its answer.",
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
    const route = await this.#route(opened);
    const { context, policy, prompt } = await this.#activation(
      opened,
      route.task,
      configuration.policyPath,
    );
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
    if (
      new EscalationHistory(this.options.persistence)
        .pending(runtime.instanceId)
        .some(
          ({ answeringAuthority, ownerSessionKey }) =>
            ownerSessionKey === input.sessionKey ||
            (answeringAuthority.kind !== "operator" &&
              answeringAuthority.sessionKey === input.sessionKey),
        )
    ) {
      throw new Error("Adjudication cannot stop while its answer is pending");
    }
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
    return this.#adjudicationRuntime(sessionKey) !== undefined;
  }

  async authorityFailure(sessionKey: string): Promise<string | undefined> {
    const runtime = this.#adjudicationRuntime(sessionKey);
    if (runtime === undefined) return undefined;
    const thread = (await this.options.t3.getShell()).threads.find(
      ({ id }) => id === runtime.threadId,
    );
    if (thread === undefined) return undefined;
    if (thread.hasPendingApprovals) {
      return "Adjudication attempted operator interaction outside its authority";
    }
    return undefined;
  }

  /**
   * Approves a pending approval request that the adjudicator raised by calling
   * one of the tools Heddle sanctioned for it, and reports whether it did.
   *
   * The adjudicator runs in `approval-required` runtime mode, so T3 Code raises
   * an approval request before every MCP tool call. Heddle registers exactly
   * one MCP server for an adjudication session and declares the tools that
   * server exposes, so a request that reports that server is a request to run a
   * sanctioned tool and Heddle answers it under its own authority. Every other
   * request is left pending for {@link authorityFailure} to read as a breach.
   */
  async settleSanctionedApprovals(
    sessionKey: string,
  ): Promise<AdjudicationApprovalOutcome> {
    const runtime = this.#adjudicationRuntime(sessionKey);
    if (runtime === undefined) return { kind: "none" };
    try {
      const thread = (await this.options.t3.getShell()).threads.find(
        ({ id }) => id === runtime.threadId,
      );
      if (thread?.hasPendingApprovals !== true) return { kind: "none" };
      return await this.#answerSanctionedToolRequests(runtime.threadId);
    } catch {
      return { kind: "none" };
    }
  }

  /**
   * Answers every pending sanctioned approval on the thread.
   *
   * Answering is asynchronous: the control plane accepts the response and a
   * separate reactor delivers it to the provider, so the request is normally
   * still pending when the dispatch returns. The pass therefore ends after
   * dispatching and a later pass reads whether the request cleared, rather
   * than waiting inside the pass and stalling every remaining session in the
   * walk. Answering again is harmless because the command id is derived from
   * the request.
   *
   * A request that never clears would otherwise defer observation forever, so
   * a request still pending beyond the configured settlement bound abandons
   * the adjudication with a cause the operator can see.
   */
  async #answerSanctionedToolRequests(
    threadId: string,
  ): Promise<AdjudicationApprovalOutcome> {
    const pending = pendingRequestActivitiesFor(
      await this.options.t3.getThread(threadId),
      "approval.requested",
    );
    if (pending.length === 0 || !pending.every(sanctionedToolApproval)) {
      return { kind: "none" };
    }
    const bound =
      this.options.configuration?.adjudication
        ?.approvalSettlementMilliseconds ??
      defaultApprovalSettlementMilliseconds;
    // Every request is answered before the bound is weighed, so no request is
    // ever abandoned without a response attempt. The scheduler visits a
    // session on a cadence, so a request recorded just after one pass would
    // otherwise be able to exceed the bound before any pass reached it.
    let dispatched = 0;
    for (const activity of pending) {
      const requestId = activity.payload?.requestId;
      if (typeof requestId !== "string" || requestId.trim() === "") continue;
      try {
        await this.options.t3.respondToApproval(
          threadId,
          requestId,
          "accept",
          stableUuid(`${threadId}:approval:${requestId}`),
        );
        dispatched += 1;
      } catch (error) {
        if (!isT3PreconditionError(error)) throw error;
      }
    }
    const unsettled = pending.filter(
      (activity) => !withinSettlementBound(activity, this.#now(), bound),
    );
    if (unsettled.length > 0) {
      return {
        cause: `Adjudication tool approval did not settle within ${bound}ms`,
        kind: "abandoned",
      };
    }
    return dispatched > 0 ? { kind: "deferred" } : { kind: "none" };
  }

  /**
   * Resolves the session runtime only for a session Heddle itself started as
   * an adjudication.
   *
   * A stage id is copied from a blueprint node id, so a lifecycle node named
   * `adjudication` would otherwise present an ordinary session as an
   * adjudication. The stored adjudication handoff is written by Heddle when it
   * starts the session and carries the session key, so a blueprint author
   * cannot produce one by naming a node.
   */
  #adjudicationRuntime(sessionKey: string): SessionRuntimeRecord | undefined {
    const runtime = this.#runtime(sessionKey);
    if (runtime?.stageId !== "adjudication") return undefined;
    const stored = this.options.persistence
      .getInstance(runtime.instanceId)
      ?.state.handoffs.filter(isStoredAdjudicationHandoff)
      .some((handoff) => handoff.sessionKey === sessionKey);
    return stored === true ? runtime : undefined;
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
    return {
      candidatePosition: binding.candidatePosition,
      failure: failureDetail(error, this.#secrets()),
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
    const context: JsonValue = {
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
    return sanitizeIncidentValue(context, this.#secrets()) as JsonValue;
  }

  #secrets(): string[] {
    return [
      this.options.configuration.pushover.applicationToken,
      this.options.configuration.pushover.userKey,
      this.options.configuration.t3.accessToken,
      ...this.options.persistence
        .listInstances()
        .flatMap(({ state }) => Object.values(state.correlationTokens)),
    ];
  }

  async #activation(
    opened: AdjudicationEscalation,
    task: BoardTask,
    policyPath: string,
  ): Promise<AdjudicationActivation> {
    const retained = this.options.persistence
      .getInstance(opened.instanceId)
      ?.state.handoffs.filter(isStoredAdjudicationHandoff)
      .filter(
        (handoff) =>
          handoff.sessionKey === opened.answeringAuthority.sessionKey &&
          handoff.escalationId === opened.escalationId &&
          handoff.ownerSessionKey === opened.ownerSessionKey,
      );
    if (retained !== undefined && retained.length > 1) {
      throw new Error("Adjudication occurrence has multiple retained handoffs");
    }
    if (retained?.[0] !== undefined) {
      const stored = retained[0];
      const handoff = parseAdjudicationHandoff(stored.handoff);
      const policy = await readAdjudicationPolicyBlob({
        blobHash: handoff.policy.blobHash,
        path: handoff.policy.path,
        repositoryRoot: this.options.blueprintRepository.repositoryRoot,
      });
      const expectedPrompt = renderPrompt({ context: handoff.context, policy });
      if (
        handoff.decisionBoundary !==
          renderAdjudicationBoundary(policy.policy) ||
        stored.renderedHandoff !== expectedPrompt
      ) {
        throw new Error(
          "Retained adjudication handoff disagrees with its policy blob",
        );
      }
      return {
        context: handoff.context,
        policy,
        prompt: expectedPrompt,
      };
    }
    const policy = await readPinnedAdjudicationPolicy({
      path: policyPath,
      repositoryRoot: this.options.blueprintRepository.repositoryRoot,
      sourceRef: this.options.blueprintRepository.sourceRef,
    });
    const context = await this.#context(opened, task, policy);
    return { context, policy, prompt: renderPrompt({ context, policy }) };
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
