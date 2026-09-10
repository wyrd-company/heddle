// ---
// relationships:
//   implements: heddle
// ---

import { createHash } from "node:crypto";

import type { BoardTask } from "../board-adapter/index.js";
import type { AgentNameAllocator } from "../agent-names/index.js";
import { AttentionVisibleError } from "../attention-visible-error.js";
import { describeError, errorDetail } from "../error-details.js";
import {
  bootstrapStageSession,
  HandoffRenderError,
  HandoffTemplateError,
  mechanicalChangeContextKey,
  SessionStartFailure,
  type SessionT3Client,
  type SessionTemplateAuthority,
  type SystemPromptResolver,
  type T3ShellThread,
} from "../control-plane/index.js";
import {
  readLifecycleContext,
  UnexpectedLandingError,
  type LifecycleContextRecord,
  type LifecycleSnapshot,
  type MechanicalNodeUse,
} from "../engine/index.js";
import type { PacingDeferral } from "../pacing/index.js";
import type {
  JsonValue,
  IncidentRuntimeRecord,
  ProviderCandidateFailureDetail,
  ReconcilerRuntimeRecord,
  ResolvedSessionBinding,
  SessionRuntimeRecord,
  SkippedProviderCandidate,
  SqlitePersistence,
} from "../persistence/index.js";
import {
  instanceIdForTask,
  type DeferReconcilerInstanceInput,
  type ReconcilerInstance,
  type ReconcilerAttentionQueue,
  type ReconcilerInstanceController,
  type StartReconcilerInstanceInput,
} from "../reconciler/index.js";
import type { ProductLifecycleResolver } from "./product-lifecycle-resolver.js";
import { isTodoState } from "../todo/index.js";
import type { ResolvedProductionConfiguration } from "./configuration.js";
import { sanitizeIncidentValue } from "./incident-redaction.js";
import {
  createProductionErrorAttention,
  type ProductionErrorCode,
} from "./error-visibility.js";
import { heddleSessionTitle } from "./session-title.js";
import {
  bindResolvedSession,
  modelSelectionFromBinding,
  providerContextFromBinding,
} from "./session-binding.js";
import { readProductionHandoffStage } from "./stage-handoff.js";
import {
  resolveStageSessionSelection,
  StartupProviderSelectionResolver,
  type StageProviderSelectionResolver,
} from "./stage-session-selection.js";
import type { EpicProjectCoordinator } from "./epic-projects.js";
import type { ProductionLifecycleRouter } from "./lifecycle-router.js";
import {
  TaskRoutingAttentionError,
  type ProductRoutingCatalog,
} from "./product-routing.js";

const json = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value)) as JsonValue;

const taskContract = (task: BoardTask): JsonValue => {
  const contract = { ...task } as Partial<BoardTask>;
  delete contract.frontMatter;
  return json(contract);
};

const retainedProviderAliases = (
  context: LifecycleContextRecord,
  task: BoardTask,
): BoardTask["providerAlias"] => {
  if (context.serializedContext === null) return task.providerAlias;
  const serialized = JSON.parse(context.serializedContext) as Record<
    string,
    unknown
  >;
  const retained = serialized["taskContract"];
  if (
    typeof retained !== "object" ||
    retained === null ||
    Array.isArray(retained) ||
    (retained as Record<string, unknown>)["id"] !== task.id
  ) {
    return task.providerAlias;
  }
  return (retained as Partial<BoardTask>).providerAlias;
};

const stableUuid = (seed: string): string => {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
};

const deferral = (value: JsonValue | undefined): PacingDeferral | undefined =>
  value as PacingDeferral | undefined;

const synchronizationAttentionId = (
  runtime: ReconcilerRuntimeRecord,
  code: ProductionErrorCode,
): string => `production:${code}:task:${runtime.taskId}:${runtime.instanceId}`;

const providerFallbackAttentionId = (
  code: "provider-alias-exhausted" | "provider-fallback-active",
  sessionKey: string,
  candidatePosition?: number,
): string =>
  `production:${code}:session:${createHash("sha256")
    .update(
      `${sessionKey}${candidatePosition === undefined ? "" : `:${candidatePosition}`}`,
    )
    .digest("hex")
    .slice(0, 16)}`;

const skippedProviderCandidate = (
  binding: ResolvedSessionBinding,
  failure: ProviderCandidateFailureDetail,
): SkippedProviderCandidate => ({
  candidatePosition: binding.candidatePosition,
  failure,
  modelSlug: binding.modelSlug,
  providerDisplayName: binding.providerDisplayName,
});

const describeSkippedCandidates = (
  candidates: readonly SkippedProviderCandidate[],
): string =>
  candidates
    .map(
      ({ candidatePosition, failure, modelSlug, providerDisplayName }) =>
        `candidate ${candidatePosition} '${providerDisplayName}' model '${modelSlug}': ${failure.message}`,
    )
    .join("; ");

const mergeSkippedCandidates = (
  ...groups: readonly (readonly SkippedProviderCandidate[])[]
): SkippedProviderCandidate[] => {
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
};

export class ProductionInstanceController implements ReconcilerInstanceController {
  public constructor(
    private readonly configuration: ResolvedProductionConfiguration,
    private readonly persistence: SqlitePersistence,
    private readonly lifecycle: ProductionLifecycleRouter,
    private readonly routing: ProductRoutingCatalog,
    private readonly projects: EpicProjectCoordinator,
    private readonly attention: ReconcilerAttentionQueue,
    private readonly t3: SessionT3Client,
    private readonly workflowMcpEndpoint: string,
    private readonly resolveSystemPrompt: SystemPromptResolver,
    private readonly templateAuthority: SessionTemplateAuthority,
    private readonly boardStatusFor: (
      instanceId: string,
      uses: MechanicalNodeUse,
    ) => Promise<string | undefined> = async () => undefined,
    private readonly mirrorBoardStatus: (
      taskId: number,
      status: string,
    ) => Promise<void> = async () => undefined,
    private readonly now: () => number = Date.now,
    private readonly providerSelection?: StageProviderSelectionResolver,
    private readonly agentNames?: AgentNameAllocator,
    private readonly taskLifecycleResolver?: Pick<
      ProductLifecycleResolver,
      "resolve" | "validateTaskProviderAliases"
    >,
  ) {}

  private sessionSelectionResolver(): StageProviderSelectionResolver {
    return (
      this.providerSelection ??
      new StartupProviderSelectionResolver(
        this.configuration.session.resolvedSelections,
      )
    );
  }

  #providerFailureDetail(
    instanceId: string,
    failure: unknown,
  ): ProviderCandidateFailureDetail {
    const correlationTokens = Object.values(
      this.persistence.getInstance(instanceId)?.state.correlationTokens ?? {},
    );
    return sanitizeIncidentValue(errorDetail(failure), [
      this.configuration.pushover?.applicationToken ?? "",
      this.configuration.pushover?.userKey ?? "",
      this.configuration.t3?.accessToken ?? "",
      ...correlationTokens,
    ]) as ProviderCandidateFailureDetail;
  }

  async #confirmProviderBindingStarted(
    task: BoardTask,
    session: SessionRuntimeRecord,
  ): Promise<void> {
    if (session.binding.candidatePosition > 1) {
      const fallback = createProductionErrorAttention({
        attentionId: providerFallbackAttentionId(
          "provider-fallback-active",
          session.sessionKey,
          session.binding.candidatePosition,
        ),
        code: "provider-fallback-active",
        error: new Error(
          session.binding.skippedCandidates.at(-1)?.failure.message ??
            "An earlier provider candidate could not start",
        ),
        instanceId: session.instanceId,
        message: `Provider alias '${session.binding.alias}' started candidate ${session.binding.candidatePosition} '${session.binding.providerDisplayName}' model '${session.binding.modelSlug}' after ${describeSkippedCandidates(session.binding.skippedCandidates)}`,
        taskId: task.id,
      });
      if (!(await this.attention.has(fallback.attentionId))) {
        await this.attention.raise(fallback);
      } else {
        this.attention.reopen(fallback.attentionId);
      }
    }
    this.persistence.confirmSessionBindingStarted(
      session.sessionKey,
      session.threadId,
    );
  }

  async recoverProviderStartFailure(
    task: BoardTask,
    target: { instanceId: string; sessionKey: string; threadId: string },
    thread: T3ShellThread | undefined,
  ): Promise<boolean> {
    const session = this.persistence
      .listSessionRuntime()
      .find(
        (candidate) =>
          candidate.instanceId === target.instanceId &&
          candidate.sessionKey === target.sessionKey &&
          candidate.threadId === target.threadId,
      );
    if (session?.bindingState !== "provisional") return false;
    if (
      thread?.latestTurn?.startedAt != null ||
      thread?.latestTurn?.state === "running" ||
      thread?.latestTurn?.state === "completed"
    ) {
      await this.#confirmProviderBindingStarted(task, session);
      return false;
    }
    if (
      thread?.session?.status === "error" ||
      thread?.latestTurn?.state === "error"
    ) {
      const cause = new Error(
        thread.session?.lastError?.trim() ||
          "T3 reported a session-start failure before the turn started",
      );
      await this.#fallbackProviderCandidate(task, session, cause);
      return true;
    }
    if (
      thread?.session?.status === "running" ||
      thread?.session?.status === "ready" ||
      thread?.session?.status === "idle"
    ) {
      await this.#confirmProviderBindingStarted(task, session);
    }
    return false;
  }

  #providerRoleCollision(
    session: SessionRuntimeRecord,
    candidateProviderInstanceId: string,
  ): Error | undefined {
    const collision = this.persistence
      .listSessionRuntime()
      .find(
        (other) =>
          other.bindingState !== "provisional" &&
          other.instanceId === session.instanceId &&
          other.sessionKey !== session.sessionKey &&
          other.binding.alias !== session.binding.alias &&
          other.binding.providerInstanceId === candidateProviderInstanceId,
      );
    return collision === undefined
      ? undefined
      : new Error(
          `Provider alias '${session.binding.alias}' cannot bind provider '${candidateProviderInstanceId}' because started alias '${collision.binding.alias}' already holds it in instance '${session.instanceId}'`,
        );
  }

  async #fallbackProviderCandidate(
    task: BoardTask,
    session: SessionRuntimeRecord,
    cause: unknown,
  ): Promise<void> {
    const resolver = this.sessionSelectionResolver();
    const selectionInputs = {
      interactionMode: session.binding.interactionMode,
      runtimeMode: session.binding.runtimeMode,
    };
    const candidates =
      resolver.resolveCandidates === undefined
        ? [
            {
              ...(await resolver.resolve(
                session.binding.alias,
                selectionInputs,
              )),
              candidatePosition: 1,
              skippedCandidates: [],
            },
          ]
        : await resolver.resolveCandidates(
            session.binding.alias,
            selectionInputs,
          );
    const configuredCurrent = candidates.find(
      ({ candidatePosition }) =>
        candidatePosition === session.binding.candidatePosition,
    );
    if (
      configuredCurrent !== undefined &&
      (configuredCurrent.providerInstanceId !==
        session.binding.providerInstanceId ||
        configuredCurrent.model.slug !== session.binding.modelSlug)
    ) {
      throw new Error(
        `Provider alias '${session.binding.alias}' changed while session '${session.sessionKey}' was starting`,
      );
    }
    let skipped = [...session.binding.skippedCandidates];
    if (
      !skipped.some(
        ({ candidatePosition }) =>
          candidatePosition === session.binding.candidatePosition,
      )
    ) {
      skipped.push(
        skippedProviderCandidate(
          session.binding,
          this.#providerFailureDetail(session.instanceId, cause),
        ),
      );
    }
    for (const candidate of candidates.filter(
      ({ candidatePosition }) =>
        candidatePosition > session.binding.candidatePosition,
    )) {
      const candidatePosition = candidate.candidatePosition;
      skipped = mergeSkippedCandidates(skipped, candidate.skippedCandidates);
      const candidateThreadId = stableUuid(
        `${session.sessionKey}:candidate:${candidatePosition}:thread`,
      );
      const candidateBinding = bindResolvedSession(
        candidate,
        session.sessionKey,
        candidateThreadId,
        candidatePosition,
        skipped,
      );
      const candidateSession: SessionRuntimeRecord = {
        ...session,
        binding: candidateBinding,
        bindingState: "provisional",
        threadId: candidateThreadId,
      };
      const collision = this.#providerRoleCollision(
        candidateSession,
        candidate.providerInstanceId,
      );
      if (collision !== undefined) {
        if (
          !skipped.some(
            ({ candidatePosition: skippedPosition }) =>
              skippedPosition === candidatePosition,
          )
        ) {
          skipped.push(
            skippedProviderCandidate(
              candidateBinding,
              this.#providerFailureDetail(session.instanceId, collision),
            ),
          );
        }
        continue;
      }
      const reconcilerRuntime = this.persistence
        .listReconcilerRuntime()
        .find(({ instanceId }) => instanceId === session.instanceId);
      if (reconcilerRuntime !== undefined) {
        const starting: ReconcilerRuntimeRecord = {
          ...reconcilerRuntime,
          provider: candidate.providerInstanceId,
          sessionKey: session.sessionKey,
          stageId: session.stageId,
          state: "starting",
          threadId: candidateThreadId,
        };
        this.persistence.writeStartingSessionRuntime(
          starting,
          candidateSession,
        );
        await this.#activate(
          task,
          session.instanceId,
          session.stageId,
          starting,
          reconcilerRuntime.boardStatus,
        );
        return;
      }
      const incidentRuntime = this.persistence
        .listIncidentRuntime()
        .find(({ incidentId }) => incidentId === session.instanceId);
      if (incidentRuntime !== undefined) {
        const starting: IncidentRuntimeRecord = {
          ...incidentRuntime,
          provider: candidate.providerInstanceId,
          sessionKey: session.sessionKey,
          stageId: session.stageId,
          state: "starting",
          threadId: candidateThreadId,
        };
        this.persistence.writeStartingIncidentSessionRuntime(
          starting,
          candidateSession,
        );
        await this.activateIncident(task, starting, session.stageId);
        return;
      }
      throw new Error(
        `Session '${session.sessionKey}' has no owning production runtime`,
      );
    }
    const exhaustedBinding: ResolvedSessionBinding = {
      ...session.binding,
      skippedCandidates: skipped,
    };
    this.persistence.writeSessionRuntime({
      ...session,
      binding: exhaustedBinding,
      bindingState: "provisional",
    });
    const exhausted = createProductionErrorAttention({
      attentionId: providerFallbackAttentionId(
        "provider-alias-exhausted",
        session.sessionKey,
      ),
      code: "provider-alias-exhausted",
      error: cause,
      instanceId: session.instanceId,
      message: `Provider alias '${session.binding.alias}' exhausted every candidate without starting the stage: ${describeSkippedCandidates(skipped)}`,
      taskId: task.id,
    });
    if (!(await this.attention.has(exhausted.attentionId))) {
      await this.attention.raise(exhausted);
    } else {
      this.attention.reopen(exhausted.attentionId);
    }
    const reconcilerRuntime = this.persistence
      .listReconcilerRuntime()
      .find(({ instanceId }) => instanceId === session.instanceId);
    if (reconcilerRuntime !== undefined) {
      this.persistence.writeReconcilerRuntime({
        ...reconcilerRuntime,
        state: "waiting",
      });
    }
    const incidentRuntime = this.persistence
      .listIncidentRuntime()
      .find(({ incidentId }) => incidentId === session.instanceId);
    if (incidentRuntime !== undefined) {
      this.persistence.writeIncidentRuntime({
        ...incidentRuntime,
        state: "waiting",
      });
    }
  }

  private async prepareAgentNames(instanceId: string): Promise<void> {
    if (this.agentNames === undefined) return;
    const kind = await this.lifecycle.agentNameThemeKind(instanceId);
    if (kind !== undefined) await this.agentNames.prepareTask(instanceId, kind);
  }

  async listInstances(): Promise<ReconcilerInstance[]> {
    const runtimes = this.persistence.listReconcilerRuntime();
    const runtimeByInstanceId = new Map(
      runtimes.map((runtime) => [runtime.instanceId, runtime]),
    );
    const sessionByKey = new Map(
      this.persistence
        .listSessionRuntime()
        .map((session) => [session.sessionKey, session]),
    );
    const activeAttentionIds = new Set(
      this.persistence.listAttention().map(({ attentionId }) => attentionId),
    );
    const topLevel = runtimes.map((runtime) => {
      const boundSession =
        runtime.sessionKey === undefined
          ? undefined
          : sessionByKey.get(runtime.sessionKey);
      const provider =
        boundSession?.binding.providerInstanceId ?? runtime.provider;
      const boardStatusMirrorBlocked = activeAttentionIds.has(
        synchronizationAttentionId(runtime, "instance-synchronization-failed"),
      );
      return {
        boardStatus: runtime.boardStatus,
        ...(boardStatusMirrorBlocked ? { boardStatusMirrorBlocked } : {}),
        ...(runtime.deferral === undefined
          ? {}
          : { deferral: deferral(runtime.deferral) }),
        depth: 0,
        instanceId: runtime.instanceId,
        ...(provider === undefined ? {} : { provider }),
        ...(runtime.stageEnteredAt === undefined
          ? {}
          : { stageEnteredAt: runtime.stageEnteredAt }),
        ...(runtime.stageId === undefined ? {} : { stageId: runtime.stageId }),
        state: runtime.state,
        taskId: runtime.taskId,
      };
    });
    const delegated = this.persistence.listInstances().flatMap((instance) => {
      const runtime = runtimeByInstanceId.get(instance.instanceId);
      if (runtime === undefined || !isTodoState(instance.state.todoState)) {
        return [];
      }
      return instance.state.todoState.lists.flatMap((list) =>
        (list.assignments ?? [])
          .filter(({ status }) => status === "active")
          .map((assignment) => ({
            boardStatus: runtime.boardStatus,
            depth: assignment.depth,
            instanceId: assignment.sessionKey,
            parentSessionId: assignment.parentSessionKey,
            provider: assignment.provider,
            state: "waiting" as const,
            taskId: runtime.taskId,
          })),
      );
    });
    return [...topLevel, ...delegated];
  }

  async defer(input: DeferReconcilerInstanceInput): Promise<void> {
    const previous = this.persistence
      .listReconcilerRuntime()
      .find(({ instanceId }) => instanceId === input.instanceId);
    this.persistence.writeReconcilerRuntime({
      ...(previous?.state === "starting" ? previous : {}),
      boardStatus: input.boardStatus,
      deferral: json(input.deferral),
      instanceId: input.instanceId,
      provider: input.provider,
      state: "deferred",
      taskId: input.taskId,
    });
  }

  async start(input: StartReconcilerInstanceInput): Promise<void> {
    const lifecycleExistedAtStart =
      this.persistence.getInstance(input.instanceId) !== undefined;
    const previous = this.persistence
      .listReconcilerRuntime()
      .find(({ instanceId }) => instanceId === input.instanceId);
    const provider = input.dispatch?.provider ?? previous?.provider;
    let starting: ReconcilerRuntimeRecord = {
      ...(previous?.state === "starting" ? previous : {}),
      boardStatus: input.task.status,
      instanceId: input.instanceId,
      ...(provider === undefined ? {} : { provider }),
      state: "starting",
      taskId: input.task.id,
    };
    const priorSessions = this.persistence
      .listSessionRuntime()
      .filter(({ instanceId }) => instanceId === input.instanceId);
    const retainedSession =
      starting.sessionKey === undefined
        ? undefined
        : priorSessions.find(
            ({ sessionKey }) => sessionKey === starting.sessionKey,
          );
    if (retainedSession !== undefined) {
      await this.prepareAgentNames(input.instanceId);
      starting = {
        ...starting,
        provider: retainedSession.binding.providerInstanceId,
        sessionKey: retainedSession.sessionKey,
        stageId: retainedSession.stageId,
        threadId: retainedSession.threadId,
      };
      this.persistence.writeStartingSessionRuntime(starting, retainedSession);
    } else {
      const stageId =
        starting.stageId ??
        (await this.lifecycle.plannedStartStage({
          blueprintPath: input.blueprintPath,
          instanceId: input.instanceId,
        }));
      await this.lifecycle.validateTaskProviderAliases(
        input.instanceId,
        input.task.id,
        input.task.providerAlias,
      );
      await this.prepareAgentNames(input.instanceId);
      if (stageId === undefined) {
        this.persistence.writeReconcilerRuntime(starting);
      } else {
        const activation =
          priorSessions
            .filter((session) => session.stageId === stageId)
            .reduce(
              (maximum, session) => Math.max(maximum, session.activation),
              0,
            ) + 1;
        const sessionKey =
          starting.sessionKey ?? `${input.instanceId}:${stageId}:${activation}`;
        const threadId =
          starting.threadId ?? stableUuid(`${sessionKey}:thread`);
        const stage = await readProductionHandoffStage({
          instanceId: input.instanceId,
          persistence: this.persistence,
          repositoryRoot: this.templateAuthority.repositoryRoot,
          stageId,
        });
        const binding = bindResolvedSession(
          await resolveStageSessionSelection(
            {
              session: this.configuration.session,
              stageId,
              stageProviderAlias: stage.providerAlias,
              stageRuntimeMode: stage.runtimeMode,
              taskId: input.task.id,
              taskProviderAliases: input.task.providerAlias,
            },
            this.sessionSelectionResolver(),
          ),
          sessionKey,
          threadId,
        );
        starting = {
          ...starting,
          provider: binding.providerInstanceId,
          sessionKey,
          stageId,
          threadId,
        };
        this.persistence.writeStartingSessionRuntime(starting, {
          activation,
          binding,
          bindingState: "provisional",
          instanceId: input.instanceId,
          sessionKey,
          stageId,
          threadId,
        });
      }
    }

    const existing = this.persistence.getInstance(input.instanceId);
    const existingContext =
      existing === undefined ? undefined : readLifecycleContext(existing);
    const snapshot =
      existing === undefined ||
      existingContext?.pendingTransition?.kind === "start"
        ? await this.lifecycle
            .start({
              blueprintPath: input.blueprintPath,
              ...(existing === undefined ||
              existingContext?.pendingTransition?.initialContext === null
                ? {
                    initialContext: {
                      ...(await this.#mechanicalChange(
                        input.task,
                        input.instanceId,
                        input.repositoryName,
                      )),
                      taskContract: taskContract(input.task),
                      taskId: input.task.id,
                    },
                  }
                : {}),
              instanceId: input.instanceId,
            })
            .catch((error: unknown) => {
              if (error instanceof UnexpectedLandingError) {
                throw new AttentionVisibleError(error);
              }
              throw error;
            })
        : existingContext;
    if (snapshot === undefined) {
      throw new Error(`Instance ${input.instanceId} recovery state is absent`);
    }
    const stageId = snapshot.awaitingNodeIds[0];
    if (stageId === undefined) {
      this.persistence.writeReconcilerRuntime({
        ...starting,
        boardStatus:
          snapshot.status === "completed"
            ? ((await this.boardStatusFor(input.instanceId, "finalize")) ??
              starting.boardStatus)
            : starting.boardStatus,
        state: snapshot.status === "completed" ? "done" : "running",
      });
      return;
    }
    const preparedBoardStatus = await this.boardStatusFor(
      input.instanceId,
      "prepare-worktree",
    );
    const restoreInitialBoardStatus =
      lifecycleExistedAtStart &&
      starting.boardStatus === "todo" &&
      preparedBoardStatus !== undefined;
    await this.#activate(
      input.task,
      input.instanceId,
      stageId,
      starting,
      !lifecycleExistedAtStart || restoreInitialBoardStatus
        ? (preparedBoardStatus ?? input.task.status)
        : starting.boardStatus,
      restoreInitialBoardStatus,
    );
  }

  async activateIncident(
    task: BoardTask,
    runtime: IncidentRuntimeRecord,
    stageId: string,
    replacementBinding?: ResolvedSessionBinding,
  ): Promise<void> {
    const starting: ReconcilerRuntimeRecord = {
      boardStatus: "incident",
      instanceId: runtime.incidentId,
      ...(runtime.provider === undefined ? {} : { provider: runtime.provider }),
      ...(runtime.sessionKey === undefined
        ? {}
        : { sessionKey: runtime.sessionKey }),
      ...(runtime.stageEnteredAt === undefined
        ? {}
        : { stageEnteredAt: runtime.stageEnteredAt }),
      ...(runtime.stageId === undefined ? {} : { stageId: runtime.stageId }),
      state: "starting",
      taskId: runtime.taskId,
      ...(runtime.threadId === undefined ? {} : { threadId: runtime.threadId }),
    };
    await this.#activate(
      task,
      runtime.incidentId,
      stageId,
      starting,
      "incident",
      false,
      (next) =>
        this.persistence.writeIncidentRuntime({
          ...runtime,
          ...(next.provider === undefined ? {} : { provider: next.provider }),
          ...(next.sessionKey === undefined
            ? {}
            : { sessionKey: next.sessionKey }),
          ...(next.stageEnteredAt === undefined
            ? {}
            : { stageEnteredAt: next.stageEnteredAt }),
          ...(next.stageId === undefined ? {} : { stageId: next.stageId }),
          state: next.state === "waiting" ? "waiting" : "starting",
          ...(next.threadId === undefined ? {} : { threadId: next.threadId }),
        }),
      replacementBinding,
    );
  }

  async reactivateStageForEscalation(input: {
    instanceId: string;
    stageId: string;
    task: BoardTask;
  }): Promise<ResolvedSessionBinding> {
    const record = this.persistence.getInstance(input.instanceId);
    if (record === undefined) {
      throw new Error(`Instance does not exist: ${input.instanceId}`);
    }
    const context = readLifecycleContext(record);
    if (
      context.status !== "awaiting" ||
      context.awaitingNodeIds.length !== 1 ||
      context.awaitingNodeIds[0] !== input.stageId
    ) {
      throw new Error(
        "Escalation delivery no longer matches the awaiting stage",
      );
    }
    const runtimes = this.persistence
      .listReconcilerRuntime()
      .filter(({ instanceId }) => instanceId === input.instanceId);
    const incidents = this.persistence
      .listIncidentRuntime()
      .filter(({ incidentId }) => incidentId === input.instanceId);
    if (runtimes.length + incidents.length !== 1) {
      throw new Error(
        "Escalation delivery has no canonical production runtime",
      );
    }
    if (runtimes.length === 1) {
      const current = runtimes[0]!;
      if (current.taskId !== input.task.id || current.state === "deferred") {
        throw new Error("Escalation delivery disagrees with its task runtime");
      }
      const retainedBinding = this.#escalatingBinding(current, input.stageId);
      const {
        sessionKey: _sessionKey,
        threadId: _threadId,
        ...retained
      } = current;
      void _sessionKey;
      void _threadId;
      const starting: ReconcilerRuntimeRecord = {
        ...retained,
        state: "starting",
      };
      this.persistence.writeReconcilerRuntime(starting);
      await this.#activate(
        input.task,
        input.instanceId,
        input.stageId,
        starting,
        starting.boardStatus,
        false,
        (runtime) => this.persistence.writeReconcilerRuntime(runtime),
        retainedBinding,
      );
    } else {
      const current = incidents[0]!;
      if (
        current.taskId !== input.task.id ||
        current.state === "done" ||
        current.state === "failed"
      ) {
        throw new Error(
          "Escalation delivery disagrees with its incident runtime",
        );
      }
      const retainedBinding = this.#escalatingBinding(
        {
          instanceId: current.incidentId,
          sessionKey: current.sessionKey,
          stageId: current.stageId,
        },
        input.stageId,
      );
      const {
        sessionKey: _sessionKey,
        threadId: _threadId,
        ...retained
      } = current;
      void _sessionKey;
      void _threadId;
      await this.activateIncident(
        input.task,
        { ...retained, state: "starting" },
        input.stageId,
        retainedBinding,
      );
    }
    const sessions = this.persistence
      .listSessionRuntime()
      .filter(
        ({ instanceId, stageId }) =>
          instanceId === input.instanceId && stageId === input.stageId,
      )
      .sort((left, right) => right.activation - left.activation);
    if (sessions.length === 0) {
      throw new Error("Escalation stage reactivation created no session");
    }
    return sessions[0]!.binding;
  }

  #escalatingBinding(
    runtime: Pick<
      ReconcilerRuntimeRecord,
      "instanceId" | "sessionKey" | "stageId"
    >,
    stageId: string,
  ): ResolvedSessionBinding {
    if (runtime.stageId !== stageId || runtime.sessionKey === undefined) {
      throw new Error("Escalation delivery disagrees with its active stage");
    }
    const matches = this.persistence
      .listSessionRuntime()
      .filter(
        (session) =>
          session.instanceId === runtime.instanceId &&
          session.stageId === stageId &&
          session.sessionKey === runtime.sessionKey,
      );
    if (matches.length !== 1) {
      throw new Error("Escalation delivery has no canonical session binding");
    }
    return matches[0]!.binding;
  }

  async prepareIncidentStart(
    runtime: IncidentRuntimeRecord,
    stageId: string,
    task?: BoardTask,
  ): Promise<IncidentRuntimeRecord> {
    if (task?.providerAlias !== undefined) {
      const taskInstanceId = instanceIdForTask(task.id);
      if (this.persistence.getInstance(taskInstanceId) !== undefined) {
        await this.lifecycle.validateTaskProviderAliases(
          taskInstanceId,
          task.id,
          task.providerAlias,
        );
      } else if (this.taskLifecycleResolver !== undefined) {
        await this.taskLifecycleResolver.validateTaskProviderAliases(
          task,
          task.providerAlias,
        );
      } else {
        throw new Error(
          `Task ${task.id} provider-alias has no normal lifecycle authority`,
        );
      }
    }
    await this.prepareAgentNames(runtime.incidentId);
    const priorSessions = this.persistence
      .listSessionRuntime()
      .filter(
        (session) =>
          session.instanceId === runtime.incidentId &&
          session.stageId === stageId,
      );
    const activation =
      priorSessions.reduce(
        (maximum, session) => Math.max(maximum, session.activation),
        0,
      ) + 1;
    const sessionKey = `${runtime.incidentId}:${stageId}:${activation}`;
    const threadId = stableUuid(`${sessionKey}:thread`);
    const stage = await readProductionHandoffStage({
      instanceId: runtime.incidentId,
      persistence: this.persistence,
      repositoryRoot: this.templateAuthority.repositoryRoot,
      stageId,
    });
    const binding = bindResolvedSession(
      await resolveStageSessionSelection(
        {
          session: this.configuration.session,
          stageId,
          stageProviderAlias: stage.providerAlias,
          stageRuntimeMode: stage.runtimeMode,
          taskId: task?.id ?? runtime.taskId,
          taskProviderAliases: task?.providerAlias,
        },
        this.sessionSelectionResolver(),
      ),
      sessionKey,
      threadId,
    );
    const prepared: IncidentRuntimeRecord = {
      ...runtime,
      provider: binding.providerInstanceId,
      sessionKey,
      stageId,
      state: "starting",
      threadId,
    };
    this.persistence.writeStartingIncidentSessionRuntime(prepared, {
      activation,
      binding,
      bindingState: "provisional",
      instanceId: runtime.incidentId,
      sessionKey,
      stageId,
      threadId,
    });
    return prepared;
  }

  async #mechanicalChange(
    task: BoardTask,
    instanceId: string,
    repositoryName?: string,
  ): Promise<Record<string, JsonValue>> {
    let repository;
    try {
      repository = this.routing.repositoryForStage(task, repositoryName);
    } catch (error) {
      if (!(error instanceof TaskRoutingAttentionError)) throw error;
      await this.#raiseInitialRoutingAttention(instanceId, error);
      return {};
    }
    const session = this.configuration.session;
    return {
      [mechanicalChangeContextKey]: json({
        baseBranch: this.projects.baseBranchForTask(task),
        branch: `heddle/task-${task.id}`,
        repositoryName: repository.name,
        repositoryRoot: repository.repositoryRoot,
        reviewDescription: `Task ${task.id}: ${task.title}`,
        reviewTitle: task.title,
        taskId: task.id,
        worktreeName: String(task.id),
        ...(session.worktreesRoot === undefined
          ? {}
          : { worktreesRoot: session.worktreesRoot }),
      }),
    };
  }

  async #raiseInitialRoutingAttention(
    instanceId: string,
    error: TaskRoutingAttentionError,
  ): Promise<void> {
    const attentionId = `production:initial-routing-failed:task:${error.taskId}:${instanceId}`;
    if (await this.attention.has(attentionId)) return;
    await this.attention.raise({
      attentionId,
      code: error.code,
      instanceId,
      kind: "lifecycle-resolution",
      message: error.message,
      taskId: error.taskId,
    });
  }

  async synchronize(tasks: readonly BoardTask[]): Promise<void> {
    const tasksById = new Map(tasks.map((task) => [task.id, task]));
    const activeAttentionIds = new Set(
      this.persistence.listAttention().map(({ attentionId }) => attentionId),
    );
    for (const runtime of this.persistence.listReconcilerRuntime()) {
      const retryAttentionIds = [
        `production:task-reconciliation-failed:task:${runtime.taskId}`,
        `production:instance-synchronization-failed:task:${runtime.taskId}:${runtime.instanceId}`,
        `production:instance-start-incomplete:task:${runtime.taskId}:${runtime.instanceId}`,
      ];
      const activeRetryAttentionIds = retryAttentionIds.filter((attentionId) =>
        activeAttentionIds.has(attentionId),
      );
      if (
        activeRetryAttentionIds.some(
          (attentionId) =>
            !this.persistence.incidentFailureRetryReady(
              attentionId,
              this.now(),
            ),
        )
      ) {
        continue;
      }
      try {
        const record = this.persistence.getInstance(runtime.instanceId);
        if (record === undefined) {
          if (runtime.state === "deferred") {
            continue;
          }
          if (runtime.state === "starting") {
            const attentionId = synchronizationAttentionId(
              runtime,
              "instance-start-incomplete",
            );
            if (!activeAttentionIds.has(attentionId)) {
              await this.#raiseSynchronizationError(
                runtime,
                "instance-start-incomplete",
                new Error(
                  `Instance ${runtime.instanceId} retained starting state without lifecycle activation`,
                ),
              );
              continue;
            }
            const task = tasksById.get(runtime.taskId);
            if (task === undefined) {
              await this.#raiseSynchronizationError(
                runtime,
                "board-task-absent",
                new Error(
                  `Task ${runtime.taskId} is absent during lifecycle synchronization`,
                ),
              );
              continue;
            }
            if (this.taskLifecycleResolver === undefined) {
              throw new Error(
                `Instance ${runtime.instanceId} has no lifecycle resolution authority for start recovery`,
              );
            }
            const resolution = await this.taskLifecycleResolver.resolve(task);
            if (resolution.kind === "attention-required") {
              throw new Error(resolution.attention.message);
            }
            await this.start({
              blueprintPath: resolution.blueprintPath,
              instanceId: runtime.instanceId,
              ...(resolution.repositoryName === undefined
                ? {}
                : { repositoryName: resolution.repositoryName }),
              task,
            });
            await this.#resolveSynchronizationError(
              runtime,
              "instance-start-incomplete",
            );
            await this.#resolveTaskReconciliationError(runtime);
            await this.#resolveSynchronizationError(
              runtime,
              "instance-synchronization-failed",
            );
            continue;
          }
          await this.#raiseSynchronizationError(
            runtime,
            "lifecycle-instance-absent",
            new Error(
              `Instance ${runtime.instanceId} has runtime state but no lifecycle state`,
            ),
          );
          continue;
        }
        await this.#resolveSynchronizationError(
          runtime,
          "lifecycle-instance-absent",
        );
        const task = tasksById.get(runtime.taskId);
        if (task === undefined) {
          await this.#raiseSynchronizationError(
            runtime,
            "board-task-absent",
            new Error(
              `Task ${runtime.taskId} is absent during lifecycle synchronization`,
            ),
          );
          continue;
        }
        const context = readLifecycleContext(record);
        if (context.pendingTransition !== null) {
          if (this.lifecycle.isTransitionActive(runtime.instanceId)) continue;
          const snapshot = await this.#replayPendingTransition(
            runtime.instanceId,
            context,
          ).catch((error: unknown) => {
            if (error instanceof UnexpectedLandingError) {
              throw new AttentionVisibleError(error);
            }
            throw error;
          });
          await this.#synchronizeSnapshot(
            task,
            runtime,
            snapshot,
            retainedProviderAliases(context, task),
          );
          await this.#resolveTaskReconciliationError(runtime);
          await this.#resolveSynchronizationError(
            runtime,
            "instance-synchronization-failed",
          );
          continue;
        }
        await this.#synchronizeSnapshot(
          task,
          runtime,
          context,
          retainedProviderAliases(context, task),
        );
        await this.#resolveTaskReconciliationError(runtime);
        await this.#resolveSynchronizationError(
          runtime,
          "instance-synchronization-failed",
        );
      } catch (error) {
        if (error instanceof AttentionVisibleError) continue;
        await this.#raiseSynchronizationError(
          runtime,
          "instance-synchronization-failed",
          error,
        );
      }
    }
  }

  async #replayPendingTransition(
    instanceId: string,
    context: LifecycleContextRecord,
  ): Promise<LifecycleSnapshot> {
    const pending = context.pendingTransition;
    if (pending === null) {
      throw new Error(`Instance ${instanceId} has no pending transition`);
    }
    if (pending.kind === "start") {
      return this.lifecycle.start({
        blueprintPath: context.blueprintPath,
        instanceId,
      });
    }
    if (pending.disposition === null || pending.operationId === null) {
      throw new Error(
        `Instance ${instanceId} pending resume transition is incomplete`,
      );
    }
    return this.lifecycle.resume({
      disposition: pending.disposition,
      instanceId,
      operationId: pending.operationId,
      ...(pending.output === null ? {} : { output: pending.output }),
    });
  }

  async #synchronizeSnapshot(
    task: BoardTask,
    runtime: ReconcilerRuntimeRecord,
    snapshot: Pick<LifecycleContextRecord, "awaitingNodeIds" | "status">,
    providerAliases: BoardTask["providerAlias"],
  ): Promise<void> {
    const stageId = snapshot.awaitingNodeIds[0];
    if (stageId === undefined) {
      this.persistence.writeReconcilerRuntime({
        ...runtime,
        boardStatus:
          snapshot.status === "completed"
            ? ((await this.boardStatusFor(runtime.instanceId, "finalize")) ??
              runtime.boardStatus)
            : runtime.boardStatus,
        state: snapshot.status === "completed" ? "done" : "running",
      });
      return;
    }
    const sameStage = runtime.stageId === stageId;
    if (sameStage && runtime.state === "waiting") {
      const preparedBoardStatus = await this.boardStatusFor(
        runtime.instanceId,
        "prepare-worktree",
      );
      if (runtime.boardStatus === "todo" && preparedBoardStatus !== undefined) {
        this.persistence.writeReconcilerRuntime({
          ...runtime,
          boardStatus: preparedBoardStatus,
        });
        await this.mirrorBoardStatus(task.id, preparedBoardStatus);
      }
      return;
    }
    const restoreInitialBoardStatus =
      runtime.state === "starting" && runtime.boardStatus === "todo";
    await this.lifecycle.validateTaskProviderAliases(
      runtime.instanceId,
      task.id,
      providerAliases,
    );
    const starting: ReconcilerRuntimeRecord = {
      ...runtime,
      boardStatus: sameStage ? runtime.boardStatus : task.status,
      state: "starting",
    };
    this.persistence.writeReconcilerRuntime(starting);
    const boardStatus = restoreInitialBoardStatus
      ? ((await this.boardStatusFor(runtime.instanceId, "prepare-worktree")) ??
        starting.boardStatus)
      : starting.boardStatus;
    await this.#activate(
      task,
      runtime.instanceId,
      stageId,
      starting,
      boardStatus,
      restoreInitialBoardStatus,
    );
  }

  async #raiseSynchronizationError(
    runtime: ReconcilerRuntimeRecord,
    code: ProductionErrorCode,
    error: unknown,
  ): Promise<void> {
    const attentionId = synchronizationAttentionId(runtime, code);
    if (await this.attention.has(attentionId)) {
      this.attention.reopen(attentionId);
      return;
    }
    await this.attention.raise(
      createProductionErrorAttention({
        attentionId,
        code,
        error,
        instanceId: runtime.instanceId,
        message: `Instance ${runtime.instanceId} synchronization failed: ${describeError(error)}`,
        taskId: runtime.taskId,
      }),
    );
  }

  async #resolveSynchronizationError(
    runtime: ReconcilerRuntimeRecord,
    code: ProductionErrorCode,
  ): Promise<void> {
    const attentionId = synchronizationAttentionId(runtime, code);
    if (await this.attention.has(attentionId)) {
      this.attention.resolve(attentionId);
    }
  }

  async #resolveTaskReconciliationError(
    runtime: ReconcilerRuntimeRecord,
  ): Promise<void> {
    const attentionId = `production:task-reconciliation-failed:task:${runtime.taskId}`;
    if (await this.attention.has(attentionId)) {
      this.attention.resolve(attentionId);
    }
  }

  async #activate(
    task: BoardTask,
    instanceId: string,
    stageId: string,
    starting: ReconcilerRuntimeRecord,
    boardStatus: string = starting.boardStatus,
    mirrorBoardStatus: boolean = false,
    writeRuntime: (runtime: ReconcilerRuntimeRecord) => void = (runtime) =>
      this.persistence.writeReconcilerRuntime(runtime),
    replacementBinding?: ResolvedSessionBinding,
  ): Promise<void> {
    const retryingIntent =
      starting.state === "starting" &&
      starting.stageId === stageId &&
      starting.sessionKey !== undefined &&
      starting.threadId !== undefined;
    const priorSessions = this.persistence
      .listSessionRuntime()
      .filter(
        (session) =>
          session.instanceId === instanceId && session.stageId === stageId,
      );
    const intendedSession = retryingIntent
      ? priorSessions.find(
          (session) => session.sessionKey === starting.sessionKey,
        )
      : undefined;
    const activation =
      intendedSession === undefined
        ? priorSessions.reduce(
            (maximum, session) => Math.max(maximum, session.activation),
            0,
          ) + 1
        : intendedSession.activation;
    const sessionKey = retryingIntent
      ? starting.sessionKey!
      : `${instanceId}:${stageId}:${activation}`;
    const threadId = retryingIntent
      ? starting.threadId!
      : stableUuid(`${sessionKey}:thread`);
    writeRuntime({
      ...starting,
      sessionKey,
      stageEnteredAt: this.now(),
      stageId,
      threadId,
    });
    let idIndex = 0;
    const nextId = (): string => {
      const value =
        idIndex === 0
          ? threadId
          : stableUuid(`${sessionKey}:dispatch:${idIndex}`);
      idIndex += 1;
      return value;
    };
    const stage = await readProductionHandoffStage({
      instanceId,
      persistence: this.persistence,
      repositoryRoot: this.templateAuthority.repositoryRoot,
      stageId,
    });
    const agentName =
      stage.agentNameList === undefined
        ? undefined
        : await this.requireAgentNames().assign(
            instanceId,
            stage.agentNameList,
          );
    const session = this.configuration.session;
    const binding =
      intendedSession?.binding ??
      (replacementBinding === undefined
        ? bindResolvedSession(
            await resolveStageSessionSelection(
              {
                session,
                stageId,
                stageProviderAlias: stage.providerAlias,
                stageRuntimeMode: stage.runtimeMode,
                taskId: task.id,
                taskProviderAliases: task.providerAlias,
              },
              this.sessionSelectionResolver(),
            ),
            sessionKey,
            threadId,
          )
        : { ...replacementBinding, sessionKey, threadId });
    if (stage.contractIssue !== undefined) {
      const attentionId = `${sessionKey}:advance-output:${stage.contractIssue.field}`;
      if (!(await this.attention.has(attentionId))) {
        const priorStage =
          stage.contractIssue.priorStageId === undefined
            ? "the prior stage"
            : `stage ${JSON.stringify(stage.contractIssue.priorStageId)}`;
        await this.attention.raise({
          attentionId,
          code: "advance-output-contract-missing",
          instanceId,
          kind: "lifecycle-resolution",
          message: `Remediation stage ${JSON.stringify(stageId)} received no ${stage.contractIssue.field} field from ${priorStage}; activation continues with no reviewer findings`,
          taskId: task.id,
        });
      }
    }
    const repository = this.routing.repositoryForStage(
      task,
      stage.repositoryName,
    );
    const projectId = this.projects.projectForTask(task);
    const sessionRuntime: SessionRuntimeRecord = {
      activation,
      binding,
      ...((replacementBinding === undefined && intendedSession === undefined) ||
      intendedSession?.bindingState === "provisional"
        ? { bindingState: "provisional" as const }
        : {}),
      instanceId,
      projectId,
      repositoryName: repository.name,
      sessionKey,
      stageId,
      threadId,
    };
    this.persistence.writeSessionRuntime(sessionRuntime);
    if (
      sessionRuntime.bindingState === "provisional" &&
      binding.candidatePosition > 1
    ) {
      const collision = this.#providerRoleCollision(
        sessionRuntime,
        binding.providerInstanceId,
      );
      if (collision !== undefined) {
        await this.#fallbackProviderCandidate(task, sessionRuntime, collision);
        return;
      }
    }
    try {
      await bootstrapStageSession(
        {
          handoff: {
            skillPointer: session.skillPointer,
            stage: {
              ...stage.handoff,
              ...(agentName === undefined ? {} : { agentName }),
            },
            taskContract: taskContract(task),
          },
          instanceId,
          interactionMode: binding.interactionMode,
          modelSelection: modelSelectionFromBinding(binding),
          projectId,
          providerContext: providerContextFromBinding(binding),
          replaceStoredHandoffAuthentication:
            sessionRuntime.bindingState === "provisional" &&
            binding.candidatePosition > 1,
          runtimeMode: binding.runtimeMode,
          sessionKey,
          task: task.frontMatter,
          taskId: task.id,
          title: heddleSessionTitle(task.id, `${stageId}-${activation}`),
          worktree: {
            baseRef: session.baseRef,
            branch: `heddle/task-${task.id}`,
            repositoryName: repository.name,
            repositoryRoot: repository.repositoryRoot,
            worktreeName: String(task.id),
            ...(session.worktreesRoot === undefined
              ? {}
              : { worktreesRoot: session.worktreesRoot }),
          },
        },
        {
          activationEvents: this.persistence,
          nextId,
          persistence: this.persistence,
          resolveSystemPrompt: this.resolveSystemPrompt,
          templateAuthority: this.templateAuthority,
          t3: {
            dispatch: (command, providerContext) =>
              this.t3.dispatch(command, providerContext),
            registerWorkflowMcpProviderSession: (registration) =>
              this.t3.registerWorkflowMcpProviderSession(registration),
          },
          workflowMcpEndpoint: this.workflowMcpEndpoint,
        },
      );
    } catch (error) {
      await this.mirrorBoardStatus(task.id, starting.boardStatus).catch(
        () => undefined,
      );
      if (
        error instanceof SessionStartFailure &&
        sessionRuntime.bindingState === "provisional"
      ) {
        await this.#fallbackProviderCandidate(task, sessionRuntime, error);
        return;
      }
      if (
        !(error instanceof HandoffRenderError) &&
        !(error instanceof HandoffTemplateError)
      ) {
        throw error;
      }
      const attentionId = `${sessionKey}:handoff-render`;
      if (!(await this.attention.has(attentionId))) {
        await this.attention.raise({
          attentionId,
          code: "handoff-render-failed",
          instanceId,
          kind: "lifecycle-resolution",
          message: error.message,
          taskId: task.id,
        });
      }
      throw new AttentionVisibleError(error);
    }
    writeRuntime({
      ...starting,
      boardStatus,
      sessionKey,
      stageEnteredAt: this.now(),
      stageId,
      state: "waiting",
      threadId,
    });
    if (mirrorBoardStatus) {
      await this.mirrorBoardStatus(task.id, boardStatus);
    }
  }

  private requireAgentNames(): AgentNameAllocator {
    if (this.agentNames === undefined) {
      throw new Error("Agent-name allocation is not configured");
    }
    return this.agentNames;
  }
}
