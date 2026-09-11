// ---
// relationships:
//   implements: heddle
// ---

import {
  bootstrapStageSession,
  SessionStartFailure,
  type SessionBootstrapDependencies,
  type SessionBootstrapInput,
} from "../control-plane/session-bootstrap.js";
import {
  ProviderAliasUnusableError,
  ProviderSelectionError,
} from "../control-plane/provider-selection.js";
import type {
  SessionObservationResult,
  SessionObservationTarget,
} from "../control-plane/session-observation-types.js";
import { errorDetail } from "../error-details.js";
import type {
  DispatchPacingEvaluator,
  PacingDeferral,
  PacingSession,
} from "../pacing/index.js";
import {
  sameResolvedSessionBinding,
  type ProviderCandidateFailureDetail,
  type ResolvedSessionBinding,
  type ResolvedSessionRuntimeMode,
  type SkippedProviderCandidate,
} from "../persistence/index.js";
import type { ProviderAliasListing } from "../control-plane/index.js";
import type { WorkflowMcpSessionBinding } from "../mcp-server/types.js";
import { isTodoState } from "../todo/index.js";
import {
  assignmentForChild,
  claimTodoAssignment,
  mutateTodoAssignment,
  replaceTodoAssignmentCandidate,
  type DelegationStateStore,
} from "./delegation-state.js";
import { stopTodoAssignmentTree } from "./delegation-teardown.js";
import type { TodoAssignment } from "../todo/types.js";

export type SpawnSubagentInput = {
  operationId: string;
  providerAlias: string;
  rootItemId: string;
};

export type SpawnSubagentResult =
  | {
      assignment: TodoAssignment;
      kind: "spawned";
    }
  | {
      deferral: PacingDeferral;
      kind: "deferred";
    };

export class DelegatedProviderExhaustionError extends ProviderSelectionError {
  constructor(
    readonly alias: string,
    readonly skippedCandidates: readonly SkippedProviderCandidate[],
    options?: ErrorOptions,
  ) {
    super(
      "provider-alias-exhausted",
      `Provider alias '${alias}' exhausted every delegated candidate: ${skippedCandidates
        .map(({ failure }) => failure.message)
        .join("; ")}`,
    );
    if (options !== undefined && "cause" in options) this.cause = options.cause;
    this.name = "DelegatedProviderExhaustionError";
  }
}

export type SubagentLiveness = {
  kind: "crashed" | "stopped" | "working";
  phase: SessionObservationResult["phase"];
  sessionKey: string;
  threadId: string;
};

type ChildIdentity = {
  correlationToken: string;
  sessionKey: string;
  threadId: string;
};

export type SubagentSessionPreparation = Pick<
  SessionBootstrapInput,
  | "interactionMode"
  | "modelSelection"
  | "projectId"
  | "providerContext"
  | "runtimeMode"
  | "task"
  | "taskId"
  | "title"
  | "worktree"
> & { binding: ResolvedSessionBinding };

export type SubagentCoordinatorOptions = {
  activeSessions(): Promise<readonly PacingSession[]>;
  bootstrap?: typeof bootstrapStageSession;
  bootstrapDependencies: SessionBootstrapDependencies;
  nextId?: () => string;
  now?: () => string;
  observeChild(
    target: SessionObservationTarget,
  ): Promise<SessionObservationResult>;
  onBootstrapFailure?(input: {
    error: unknown;
    instanceId: string;
    sessionKey: string;
    taskId: number;
  }): Promise<void>;
  onProviderExhaustion?(input: {
    binding: WorkflowMcpSessionBinding;
    error: DelegatedProviderExhaustionError;
    operationId: string;
  }): Promise<void>;
  providerFailureDetail?(
    error: unknown,
    binding: ResolvedSessionBinding,
  ): ProviderCandidateFailureDetail;
  pacing: DispatchPacingEvaluator;
  persistence: DelegationStateStore;
  providerSelection: {
    list(): Promise<ProviderAliasListing>;
    resolve(input: {
      alias: string;
      runtimeMode: ResolvedSessionRuntimeMode;
      sessionKey: string;
      threadId: string;
    }): Promise<ResolvedSessionBinding>;
    resolveCandidates?(input: {
      alias: string;
      runtimeMode: ResolvedSessionRuntimeMode;
      sessionKey: string;
      threadId: string;
    }): Promise<
      readonly {
        binding: ResolvedSessionBinding;
        catalogFailures: readonly SkippedProviderCandidate[];
      }[]
    >;
    runtimeModeFor(sessionKey: string): Promise<ResolvedSessionRuntimeMode>;
  };
  prepareSession(input: {
    binding: WorkflowMcpSessionBinding;
    identity: ChildIdentity;
    model: string;
    provider: string;
    resolvedBinding?: ResolvedSessionBinding;
    rootItemId: string;
  }): Promise<SubagentSessionPreparation>;
  sessionTargetFor(
    binding: WorkflowMcpSessionBinding,
  ): SessionObservationTarget;
  steerParent(input: {
    assignment: TodoAssignment;
    message: string;
  }): Promise<void>;
};

const nonEmpty = (name: string, value: string): void => {
  if (value.trim() === "") throw new TypeError(`${name} must not be empty`);
};

const terminalPhase = (phase: SessionObservationResult["phase"]): boolean =>
  phase === "absent" || phase === "completed" || phase === "failed";

export class SubagentCoordinator {
  readonly #bootstrap: typeof bootstrapStageSession;
  readonly #nextId: () => string;
  readonly #now: () => string;
  readonly #notifications = new Map<string, Promise<void>>();

  constructor(private readonly options: SubagentCoordinatorOptions) {
    this.#bootstrap = options.bootstrap ?? bootstrapStageSession;
    this.#nextId = options.nextId ?? (() => globalThis.crypto.randomUUID());
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  #failureDetail(
    error: unknown,
    binding: ResolvedSessionBinding,
  ): ProviderCandidateFailureDetail {
    return (
      this.options.providerFailureDetail?.(error, binding) ?? errorDetail(error)
    );
  }

  #mergeSkippedCandidates(
    ...groups: readonly (readonly SkippedProviderCandidate[])[]
  ): SkippedProviderCandidate[] {
    const byPosition = new Map<number, SkippedProviderCandidate>();
    for (const group of groups) {
      for (const candidate of group) {
        if (!byPosition.has(candidate.candidatePosition)) {
          byPosition.set(candidate.candidatePosition, candidate);
        }
      }
    }
    return [...byPosition.values()].sort(
      (left, right) => left.candidatePosition - right.candidatePosition,
    );
  }

  #failedCandidate(
    binding: ResolvedSessionBinding,
    error: unknown,
  ): SkippedProviderCandidate {
    return {
      candidatePosition: binding.candidatePosition,
      failure: this.#failureDetail(error, binding),
      modelSlug: binding.modelSlug,
      providerDisplayName: binding.providerDisplayName,
    };
  }

  async #providerExhaustion(
    binding: WorkflowMcpSessionBinding,
    input: SpawnSubagentInput,
    skippedCandidates: readonly SkippedProviderCandidate[],
    cause: unknown,
  ): Promise<DelegatedProviderExhaustionError> {
    const error = new DelegatedProviderExhaustionError(
      input.providerAlias,
      skippedCandidates,
      { cause },
    );
    await this.options.onProviderExhaustion?.({
      binding,
      error,
      operationId: input.operationId,
    });
    return error;
  }

  async #resolveProviderCandidates(
    binding: WorkflowMcpSessionBinding,
    input: SpawnSubagentInput,
    runtimeMode: ResolvedSessionRuntimeMode,
    sessionKey: string,
    threadId: string,
  ): Promise<
    readonly {
      binding: ResolvedSessionBinding;
      catalogFailures: readonly SkippedProviderCandidate[];
    }[]
  > {
    const resolveCandidates = this.options.providerSelection.resolveCandidates;
    if (resolveCandidates === undefined) return [];
    try {
      return await resolveCandidates({
        alias: input.providerAlias,
        runtimeMode,
        sessionKey,
        threadId,
      });
    } catch (error) {
      if (!(error instanceof ProviderAliasUnusableError)) throw error;
      throw await this.#providerExhaustion(
        binding,
        input,
        error.skippedCandidates,
        error,
      );
    }
  }

  async spawn(
    binding: WorkflowMcpSessionBinding,
    input: SpawnSubagentInput,
  ): Promise<SpawnSubagentResult> {
    for (const [name, value] of Object.entries(input)) nonEmpty(name, value);
    if (binding.todoAssignment !== undefined) {
      const child = assignmentForChild(binding.instance, binding.sessionKey);
      if (child.assignment.status !== "active") {
        throw new Error("The parent subagent assignment is not active");
      }
    }
    const parentTarget = this.options.sessionTargetFor(binding);
    if (
      parentTarget.instanceId !== binding.instance.instanceId ||
      parentTarget.sessionKey !== binding.sessionKey
    ) {
      throw new Error(
        "The parent observation target does not match the caller",
      );
    }
    const existing = this.#assignmentForOperation(binding, input.operationId);
    if (
      existing !== undefined &&
      (existing.rootItemId !== input.rootItemId ||
        existing.binding.alias !== input.providerAlias)
    ) {
      throw new Error(
        `Subagent operation '${input.operationId}' does not match its stored assignment`,
      );
    }
    let assignment = existing;
    let preparation: SubagentSessionPreparation;
    let providerCandidates:
      | readonly {
          binding: ResolvedSessionBinding;
          catalogFailures: readonly SkippedProviderCandidate[];
        }[]
      | undefined;
    if (assignment === undefined) {
      const identity: ChildIdentity = {
        correlationToken: this.#nextId(),
        sessionKey: this.#nextId(),
        threadId: this.#nextId(),
      };
      const runtimeMode = await this.options.providerSelection.runtimeModeFor(
        binding.sessionKey,
      );
      providerCandidates =
        this.options.providerSelection.resolveCandidates === undefined
          ? undefined
          : await this.#resolveProviderCandidates(
              binding,
              input,
              runtimeMode,
              identity.sessionKey,
              identity.threadId,
            );
      const resolvedBinding =
        providerCandidates?.[0]?.binding ??
        (await this.options.providerSelection.resolve({
          alias: input.providerAlias,
          runtimeMode,
          sessionKey: identity.sessionKey,
          threadId: identity.threadId,
        }));
      identity.threadId = resolvedBinding.threadId;
      const activeSessions = await this.options.activeSessions();
      const parent = activeSessions.find(
        ({ sessionId }) => sessionId === binding.sessionKey,
      );
      if (parent === undefined) {
        throw new Error(
          "The parent session is absent from the pacing inventory",
        );
      }
      const decision = await this.options.pacing.evaluate(
        {
          kind: "subagent",
          parentSessionId: binding.sessionKey,
          provider: resolvedBinding.providerInstanceId,
          providerAlias: resolvedBinding.alias,
          sessionId: identity.sessionKey,
        },
        activeSessions,
      );
      if (decision.kind === "defer") {
        return { deferral: decision.deferral, kind: "deferred" };
      }
      preparation = await this.options.prepareSession({
        binding,
        identity,
        model: resolvedBinding.modelSlug,
        provider: resolvedBinding.providerInstanceId,
        resolvedBinding,
        rootItemId: input.rootItemId,
      });
      assignment = claimTodoAssignment(this.options.persistence, {
        ...identity,
        binding: preparation.binding,
        bootstrap: {
          createCommandId: this.#nextId(),
          createdAt: this.#now(),
          messageId: this.#nextId(),
          turnCommandId: this.#nextId(),
        },
        depth: parent.depth + 1,
        instanceId: binding.instance.instanceId,
        listSessionKey:
          binding.todoAssignment?.listSessionKey ?? binding.sessionKey,
        model: preparation.binding.modelSlug,
        operationId: input.operationId,
        parentSessionKey: binding.sessionKey,
        parentThreadId: parentTarget.threadId,
        provider: preparation.binding.providerInstanceId,
        rootItemId: input.rootItemId,
        stage: binding.stage.id,
      });
    } else {
      if (assignment.status === "stopped") {
        return { assignment, kind: "spawned" };
      }
      if (assignment.providerFallback?.status === "pacing-deferred") {
        const activeSessions = await this.options.activeSessions();
        const decision = await this.options.pacing.evaluate(
          {
            kind: "subagent",
            parentSessionId: binding.sessionKey,
            provider: assignment.binding.providerInstanceId,
            providerAlias: assignment.binding.alias,
            sessionId: assignment.sessionKey,
          },
          activeSessions,
        );
        if (decision.kind === "defer") {
          return { deferral: decision.deferral, kind: "deferred" };
        }
      }
      preparation = await this.options.prepareSession({
        binding,
        identity: assignment,
        model: assignment.model,
        provider: assignment.provider,
        resolvedBinding: assignment.binding,
        rootItemId: assignment.rootItemId,
      });
    }
    if (assignment.status === "stopped") return { assignment, kind: "spawned" };
    if (!sameResolvedSessionBinding(preparation.binding, assignment.binding)) {
      throw new Error("Prepared subagent session changed its durable binding");
    }
    const { binding: _resolvedBinding, ...bootstrapPreparation } = preparation;
    void _resolvedBinding;
    try {
      await this.#bootstrapAssignment(
        binding,
        assignment,
        bootstrapPreparation,
      );
      if (assignment.providerFallback !== undefined) {
        assignment = this.#clearProviderFallback(binding, assignment);
      }
    } catch (error) {
      await this.options.onBootstrapFailure?.({
        error,
        instanceId: binding.instance.instanceId,
        sessionKey: assignment.sessionKey,
        taskId: preparation.taskId,
      });
      if (
        !(error instanceof SessionStartFailure) ||
        this.options.providerSelection.resolveCandidates === undefined
      ) {
        throw error;
      }
      if (assignment.providerFallback !== undefined) {
        assignment = this.#clearProviderFallback(binding, assignment);
      }
      let lastFailure: unknown = error;
      let skipped = this.#mergeSkippedCandidates(
        assignment.binding.skippedCandidates,
        [this.#failedCandidate(assignment.binding, error)],
      );
      providerCandidates ??= await this.#resolveProviderCandidates(
        binding,
        input,
        assignment.binding.runtimeMode,
        assignment.sessionKey,
        assignment.threadId,
      );
      for (const candidate of providerCandidates.filter(
        ({ binding: candidateBinding }) =>
          candidateBinding.candidatePosition >
          assignment!.binding.candidatePosition,
      )) {
        skipped = this.#mergeSkippedCandidates(
          skipped,
          candidate.binding.skippedCandidates,
        );
        const candidateBinding: ResolvedSessionBinding = {
          ...candidate.binding,
          skippedCandidates: skipped.map((failure) => ({
            ...failure,
            failure: { ...failure.failure },
          })),
        };
        const activeSessions = await this.options.activeSessions();
        const decision = await this.options.pacing.evaluate(
          {
            kind: "subagent",
            parentSessionId: binding.sessionKey,
            provider: candidateBinding.providerInstanceId,
            providerAlias: candidateBinding.alias,
            sessionId: candidateBinding.sessionKey,
          },
          activeSessions,
        );
        if (decision.kind === "defer") {
          assignment = replaceTodoAssignmentCandidate(
            this.options.persistence,
            binding.instance.instanceId,
            assignment.sessionKey,
            {
              binding: candidateBinding,
              bootstrap: {
                createCommandId: this.#nextId(),
                createdAt: this.#now(),
                messageId: this.#nextId(),
                turnCommandId: this.#nextId(),
              },
              model: candidateBinding.modelSlug,
              provider: candidateBinding.providerInstanceId,
              providerFallback: {
                status: "pacing-deferred",
              },
              threadId: candidateBinding.threadId,
            },
          );
          return { deferral: decision.deferral, kind: "deferred" };
        }
        assignment = replaceTodoAssignmentCandidate(
          this.options.persistence,
          binding.instance.instanceId,
          assignment.sessionKey,
          {
            binding: candidateBinding,
            bootstrap: {
              createCommandId: this.#nextId(),
              createdAt: this.#now(),
              messageId: this.#nextId(),
              turnCommandId: this.#nextId(),
            },
            model: candidateBinding.modelSlug,
            provider: candidateBinding.providerInstanceId,
            threadId: candidateBinding.threadId,
          },
        );
        const nextPreparation = await this.options.prepareSession({
          binding,
          identity: assignment,
          model: assignment.model,
          provider: assignment.provider,
          resolvedBinding: assignment.binding,
          rootItemId: assignment.rootItemId,
        });
        const { binding: _nextResolvedBinding, ...nextBootstrapPreparation } =
          nextPreparation;
        void _nextResolvedBinding;
        try {
          await this.#bootstrapAssignment(
            binding,
            assignment,
            nextBootstrapPreparation,
          );
          return { assignment, kind: "spawned" };
        } catch (nextError) {
          await this.options.onBootstrapFailure?.({
            error: nextError,
            instanceId: binding.instance.instanceId,
            sessionKey: assignment.sessionKey,
            taskId: nextPreparation.taskId,
          });
          if (!(nextError instanceof SessionStartFailure)) throw nextError;
          skipped = this.#mergeSkippedCandidates(skipped, [
            this.#failedCandidate(assignment.binding, nextError),
          ]);
          lastFailure = nextError;
        }
      }
      skipped = this.#mergeSkippedCandidates(
        skipped,
        ...(providerCandidates ?? []).map(
          ({ catalogFailures }) => catalogFailures,
        ),
      );
      assignment = replaceTodoAssignmentCandidate(
        this.options.persistence,
        binding.instance.instanceId,
        assignment.sessionKey,
        {
          binding: {
            ...assignment.binding,
            skippedCandidates: skipped.map((failure) => ({
              ...failure,
              failure: { ...failure.failure },
            })),
          },
          bootstrap: assignment.bootstrap,
          model: assignment.model,
          provider: assignment.provider,
          threadId: assignment.threadId,
        },
      );
      throw await this.#providerExhaustion(
        binding,
        input,
        skipped,
        lastFailure,
      );
    }
    return { assignment, kind: "spawned" };
  }

  #clearProviderFallback(
    binding: WorkflowMcpSessionBinding,
    assignment: TodoAssignment,
  ): TodoAssignment {
    return mutateTodoAssignment(
      this.options.persistence,
      binding.instance.instanceId,
      assignment.sessionKey,
      (current) => {
        const { providerFallback: _providerFallback, ...ready } = current;
        void _providerFallback;
        return ready;
      },
    );
  }

  async #bootstrapAssignment(
    parent: WorkflowMcpSessionBinding,
    assignment: TodoAssignment,
    preparation: Omit<SubagentSessionPreparation, "binding">,
  ): Promise<void> {
    await this.#bootstrap(
      {
        ...preparation,
        handoff: {
          skillPointer: this.#skillPointer(parent),
          stage: {
            agentName: this.#childAgentName(parent, assignment.sessionKey),
            kind: "standard",
            name: parent.stage.id,
            priorStageOutputs: [],
            skills: [...parent.stage.skills],
          },
          taskContract: parent.taskContext,
        },
        instanceId: parent.instance.instanceId,
        parentSessionKey: parent.sessionKey,
        sessionKey: assignment.sessionKey,
        createdAt: assignment.bootstrap.createdAt,
        threadCreateCommandId: assignment.bootstrap.createCommandId,
        threadId: assignment.threadId,
        todoAssignment: {
          listSessionKey:
            parent.todoAssignment?.listSessionKey ?? parent.sessionKey,
          rootItemId: assignment.rootItemId,
        },
        turnCommandId: assignment.bootstrap.turnCommandId,
        turnMessageId: assignment.bootstrap.messageId,
      },
      {
        ...this.options.bootstrapDependencies,
        mintCorrelationToken: () => assignment.correlationToken,
      },
    );
  }

  async listProviders(): Promise<ProviderAliasListing> {
    return this.options.providerSelection.list();
  }

  async liveness(
    binding: WorkflowMcpSessionBinding,
    sessionKey: string,
  ): Promise<SubagentLiveness> {
    const stored = assignmentForChild(
      this.#freshBindingRecord(binding),
      sessionKey,
    ).assignment;
    if (stored.parentSessionKey !== binding.sessionKey) {
      throw new Error("The caller is not the parent of this subagent");
    }
    const result = await this.options.observeChild({
      instanceId: binding.instance.instanceId,
      sessionKey: stored.sessionKey,
      threadId: stored.threadId,
    });
    return {
      kind:
        result.phase === "failed" || result.phase === "absent"
          ? "crashed"
          : result.phase === "completed"
            ? "stopped"
            : "working",
      phase: result.phase,
      sessionKey: stored.sessionKey,
      threadId: stored.threadId,
    };
  }

  async onObserved(
    target: SessionObservationTarget,
    result: SessionObservationResult,
  ): Promise<void> {
    if (!terminalPhase(result.phase)) return;
    let assignment: TodoAssignment;
    try {
      assignment = assignmentForChild(
        this.options.persistence.getInstance(target.instanceId) ??
          (() => {
            throw new Error(`Instance does not exist: ${target.instanceId}`);
          })(),
        target.sessionKey,
      ).assignment;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("is not bound to one todo assignment")
      ) {
        return;
      }
      throw error;
    }
    if (assignment.threadId !== target.threadId) {
      throw new Error("Observed child thread does not match its assignment");
    }
    const key = `${target.instanceId}:${target.sessionKey}`;
    const active = this.#notifications.get(key);
    if (active !== undefined) return active;
    const notification = this.#notifyStopped(
      target.instanceId,
      assignment,
      result,
    ).finally(() => this.#notifications.delete(key));
    this.#notifications.set(key, notification);
    return notification;
  }

  #assignmentForOperation(
    binding: WorkflowMcpSessionBinding,
    operationId: string,
  ): TodoAssignment | undefined {
    const record = this.#freshBindingRecord(binding);
    if (!isTodoState(record.state.todoState)) {
      throw new Error("The workflow instance has no valid todo state");
    }
    const matches = record.state.todoState.lists.flatMap((list) =>
      (list.assignments ?? []).filter(
        (candidate) =>
          candidate.parentSessionKey === binding.sessionKey &&
          candidate.operationId === operationId,
      ),
    );
    if (matches.length > 1) throw new Error("Subagent operation is not unique");
    return matches[0];
  }

  #freshBindingRecord(binding: WorkflowMcpSessionBinding) {
    const record = this.options.persistence.getInstance(
      binding.instance.instanceId,
    );
    if (record === undefined)
      throw new Error("The workflow instance is absent");
    return record;
  }

  #childAgentName(
    binding: WorkflowMcpSessionBinding,
    childSessionKey: string,
  ): string {
    const shortId = childSessionKey.slice(0, 8);
    return `${this.#parentAgentName(binding) ?? "subagent"}-${shortId}`;
  }

  #parentAgentName(binding: WorkflowMcpSessionBinding): string | undefined {
    let handoff: unknown;
    try {
      handoff = this.#parentHandoff(binding);
    } catch {
      handoff = undefined;
    }
    if (
      typeof handoff === "object" &&
      handoff !== null &&
      "stage" in handoff &&
      typeof handoff.stage === "object" &&
      handoff.stage !== null &&
      "agentName" in handoff.stage &&
      typeof handoff.stage.agentName === "string" &&
      handoff.stage.agentName.trim() !== ""
    ) {
      return handoff.stage.agentName;
    }
    return undefined;
  }

  #parentHandoff(binding: WorkflowMcpSessionBinding): unknown {
    const stored = binding.instance.state.handoffs.find(
      (candidate) =>
        typeof candidate === "object" &&
        candidate !== null &&
        !Array.isArray(candidate) &&
        candidate["sessionKey"] === binding.sessionKey &&
        typeof candidate["handoff"] === "string",
    );
    if (
      typeof stored !== "object" ||
      stored === null ||
      Array.isArray(stored) ||
      typeof stored["handoff"] !== "string"
    ) {
      throw new Error("The parent session has no canonical handoff");
    }
    return JSON.parse(stored["handoff"]) as unknown;
  }

  #skillPointer(binding: WorkflowMcpSessionBinding): string {
    const handoff = this.#parentHandoff(binding);
    if (
      typeof handoff !== "object" ||
      handoff === null ||
      !("skillPointer" in handoff) ||
      typeof handoff.skillPointer !== "string" ||
      handoff.skillPointer.trim() === ""
    ) {
      throw new Error("The parent handoff has no skill pointer");
    }
    return handoff.skillPointer;
  }

  async #notifyStopped(
    instanceId: string,
    current: TodoAssignment,
    result: SessionObservationResult,
  ): Promise<void> {
    let assignment = current;
    if (assignment.ancestorStop !== undefined) return;
    if (assignment.stopNotification?.status === "completed") return;
    if (assignment.stopNotification === undefined) {
      const message = `Subagent ${assignment.sessionKey} stopped with phase ${result.phase}; assigned todo subtree ${assignment.rootItemId}.`;
      const notice = {
        commandId: this.#nextId(),
        createdAt: this.#now(),
        messageId: this.#nextId(),
        message,
        phase: result.phase as "absent" | "completed" | "failed",
        status: "issued" as const,
      };
      const stopped = stopTodoAssignmentTree(
        this.options.persistence,
        instanceId,
        assignment.sessionKey,
        notice,
      );
      assignment = stopped.assignment;
      if (stopped.kind === "stopped-by-ancestor") return;
    }
    if (assignment.stopNotification?.status === "completed") return;
    await this.options.steerParent({
      assignment,
      message: assignment.stopNotification!.message,
    });
    mutateTodoAssignment(
      this.options.persistence,
      instanceId,
      assignment.sessionKey,
      (candidate) => ({
        ...candidate,
        status: "stopped",
        stopNotification: {
          ...candidate.stopNotification!,
          status: "completed",
        },
      }),
    );
  }
}
