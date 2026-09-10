// ---
// relationships:
//   implements: heddle
// ---

import {
  bootstrapStageSession,
  type SessionBootstrapDependencies,
  type SessionBootstrapInput,
} from "../control-plane/session-bootstrap.js";
import type {
  SessionObservationResult,
  SessionObservationTarget,
} from "../control-plane/session-observation-types.js";
import type {
  DispatchPacingEvaluator,
  PacingDeferral,
  PacingSession,
} from "../pacing/index.js";
import {
  sameResolvedSessionBinding,
  type ResolvedSessionBinding,
  type ResolvedSessionRuntimeMode,
} from "../persistence/index.js";
import type { ProviderAliasListing } from "../control-plane/index.js";
import type { WorkflowMcpSessionBinding } from "../mcp-server/types.js";
import { isTodoState } from "../todo/index.js";
import {
  assignmentForChild,
  claimTodoAssignment,
  mutateTodoAssignment,
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
    if (assignment === undefined) {
      const identity: ChildIdentity = {
        correlationToken: this.#nextId(),
        sessionKey: this.#nextId(),
        threadId: this.#nextId(),
      };
      const resolvedBinding = await this.options.providerSelection.resolve({
        alias: input.providerAlias,
        runtimeMode: await this.options.providerSelection.runtimeModeFor(
          binding.sessionKey,
        ),
        sessionKey: identity.sessionKey,
        threadId: identity.threadId,
      });
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
      preparation = await this.options.prepareSession({
        binding,
        identity: assignment,
        model: assignment.model,
        provider: assignment.provider,
        resolvedBinding: assignment.binding,
        rootItemId: assignment.rootItemId,
      });
    }
    if (assignment.status === "stopped") {
      return { assignment, kind: "spawned" };
    }
    if (!sameResolvedSessionBinding(preparation.binding, assignment.binding)) {
      throw new Error("Prepared subagent session changed its durable binding");
    }
    const { binding: _resolvedBinding, ...bootstrapPreparation } = preparation;
    void _resolvedBinding;
    try {
      await this.#bootstrap(
        {
          ...bootstrapPreparation,
          handoff: {
            skillPointer: this.#skillPointer(binding),
            stage: {
              agentName: this.#childAgentName(binding, assignment.sessionKey),
              kind: "standard",
              name: binding.stage.id,
              priorStageOutputs: [],
              skills: [...binding.stage.skills],
            },
            taskContract: binding.taskContext,
          },
          instanceId: binding.instance.instanceId,
          parentSessionKey: binding.sessionKey,
          sessionKey: assignment.sessionKey,
          createdAt: assignment.bootstrap.createdAt,
          threadCreateCommandId: assignment.bootstrap.createCommandId,
          threadId: assignment.threadId,
          todoAssignment: {
            listSessionKey:
              binding.todoAssignment?.listSessionKey ?? binding.sessionKey,
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
    } catch (error) {
      await this.options.onBootstrapFailure?.({
        error,
        instanceId: binding.instance.instanceId,
        sessionKey: assignment.sessionKey,
        taskId: preparation.taskId,
      });
      throw error;
    }
    return { assignment, kind: "spawned" };
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
