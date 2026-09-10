// ---
// relationships:
//   implements: heddle
// ---

import {
  escalationAnswerSchema,
  adjudicationSessionKey,
  escalationAttentionId,
  escalationKey,
  type AnsweredEscalation,
  type EscalationAnswerInput,
  type EscalationAnsweringAuthority,
  type EscalationAnswers,
  type EscalationAttention,
  type EscalationInput,
  type EscalationResult,
  type PendingEscalation,
  type SessionEscalation,
} from "./escalation-contract.js";
import {
  EscalationHistory,
  escalationEventTypes,
} from "./escalation-history.js";
import type {
  WorkflowMcpPersistence,
  WorkflowMcpSessionBinding,
} from "./types.js";
import {
  dispositionClaimFor,
  withDispositionClaim,
} from "./session-disposition-claim.js";

export interface EscalationAttentionQueue {
  raise(attention: EscalationAttention): Promise<void>;
  resolve?(attentionId: string): void | Promise<void>;
}

export interface PushoverEscalationNotifier {
  send(attention: EscalationAttention): Promise<void>;
}

export interface SessionEscalationRouter {
  steer(escalation: SessionEscalation): Promise<void>;
}

export interface AdjudicationEscalationRouter {
  start(
    escalation: PendingEscalation & {
      answeringAuthority: Extract<
        EscalationAnsweringAuthority,
        { kind: "adjudication" }
      >;
    },
  ): Promise<{ modelSlug: string }>;
  stop(input: {
    reason: "answered" | "declined" | "failed" | "withdrawn";
    sessionKey: string;
  }): Promise<void>;
}

export interface EscalationAnswerDelivery {
  deliver(input: {
    answered: AnsweredEscalation;
    commandId: string;
    opened: PendingEscalation;
  }): Promise<void>;
}

export interface EscalationDecisionLog {
  record(input: {
    answered: AnsweredEscalation;
    opened: PendingEscalation;
  }): Promise<void>;
}

export type EscalationCoordinatorOptions = {
  adjudication?: AdjudicationEscalationRouter;
  attention: EscalationAttentionQueue;
  containPushoverFailure?: (
    error: unknown,
    escalation: PendingEscalation,
  ) => Promise<boolean> | boolean;
  containSettlementFailure?: (
    error: unknown,
    escalation: PendingEscalation,
  ) => Promise<boolean> | boolean;
  decisionLog: EscalationDecisionLog;
  delivery: EscalationAnswerDelivery;
  now?: () => string;
  session: SessionEscalationRouter;
  settlementRecovered?: (escalation: PendingEscalation) => Promise<void> | void;
  persistence: WorkflowMcpPersistence;
  pushover: PushoverEscalationNotifier;
};

const attentionFrom = (opened: PendingEscalation): EscalationAttention => ({
  attentionId: opened.attentionId,
  escalationId: opened.escalationId,
  instanceId: opened.instanceId,
  openedAt: opened.openedAt,
  ownerSessionKey: opened.ownerSessionKey,
  questions: opened.questions,
  requestId: opened.requestId,
  threadId: opened.threadId,
  stage: opened.stage,
  ...(opened.adjudication === undefined
    ? {}
    : { adjudication: opened.adjudication }),
});

export class EscalationCoordinator {
  readonly #adjudication?: AdjudicationEscalationRouter;
  readonly #attention: EscalationAttentionQueue;
  readonly #containPushoverFailure?: EscalationCoordinatorOptions["containPushoverFailure"];
  readonly #containSettlementFailure?: EscalationCoordinatorOptions["containSettlementFailure"];
  readonly #history: EscalationHistory;
  readonly #decisionLog: EscalationDecisionLog;
  readonly #delivery: EscalationAnswerDelivery;
  readonly #now: () => string;
  readonly #session: SessionEscalationRouter;
  readonly #settlementRecovered?: EscalationCoordinatorOptions["settlementRecovered"];
  readonly #persistence: WorkflowMcpPersistence;
  readonly #pushover: PushoverEscalationNotifier;
  readonly #routes = new Map<string, Promise<void>>();
  readonly #settlements = new Map<string, Promise<void>>();

  constructor(options: EscalationCoordinatorOptions) {
    this.#adjudication = options.adjudication;
    this.#attention = options.attention;
    this.#containPushoverFailure = options.containPushoverFailure;
    this.#containSettlementFailure = options.containSettlementFailure;
    this.#history = new EscalationHistory(options.persistence);
    this.#decisionLog = options.decisionLog;
    this.#delivery = options.delivery;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#session = options.session;
    this.#settlementRecovered = options.settlementRecovered;
    this.#persistence = options.persistence;
    this.#pushover = options.pushover;
  }

  async escalate(
    binding: Pick<
      WorkflowMcpSessionBinding,
      "instance" | "sessionKey" | "parentSessionKey" | "stage"
    >,
    input: EscalationInput,
  ): Promise<EscalationResult> {
    const history = this.#history.open(
      binding,
      input,
      this.#now(),
      this.#adjudication === undefined
        ? { kind: "operator" }
        : {
            kind: "adjudication",
            sessionKey: adjudicationSessionKey(
              escalationAttentionId(
                binding.instance.instanceId,
                binding.sessionKey,
                input.escalationId,
              ),
            ),
          },
    );
    if (
      this.#history.find(
        binding.instance.instanceId,
        binding.sessionKey,
        input.escalationId,
      ).withdrawn
    ) {
      return { awaitingAnswer: false, escalationId: input.escalationId };
    }
    if (history.answered === undefined) {
      void this.#ensureRouted(history.opened).catch(() => undefined);
    } else {
      void this.#settle(history.opened, history.answered).catch(
        () => undefined,
      );
    }
    return {
      awaitingAnswer: history.answered === undefined,
      escalationId: history.opened.escalationId,
    };
  }

  async answerAsOperator(input: {
    answers: EscalationAnswers;
    escalationId: string;
    instanceId: string;
    ownerSessionKey: string;
    prose?: string;
  }): Promise<AnsweredEscalation> {
    const opened = this.#requireOpened(input);
    const authority = { kind: "operator" } as const;
    return this.#answer(opened, input.answers, authority, input.prose);
  }

  async answerAsSession(
    binding: WorkflowMcpSessionBinding,
    input: EscalationAnswerInput,
  ): Promise<AnsweredEscalation> {
    if (binding.adjudication !== undefined) {
      const occurrence = binding.adjudication;
      const opened = this.#requireOpened({
        escalationId: occurrence.escalationId,
        instanceId: binding.instance.instanceId,
        ownerSessionKey: occurrence.ownerSessionKey,
      });
      try {
        const parsed = escalationAnswerSchema.parse(input);
        if (
          parsed.escalationId !== occurrence.escalationId ||
          parsed.ownerSessionKey !== occurrence.ownerSessionKey
        ) {
          throw new TypeError(
            "Adjudication may answer only its bound escalation occurrence",
          );
        }
        const answered = await this.#answer(
          opened,
          parsed.answers,
          { kind: "adjudication", sessionKey: binding.sessionKey },
          parsed.prose,
          occurrence.modelSlug,
        );
        await this.#adjudication?.stop({
          reason: "answered",
          sessionKey: binding.sessionKey,
        });
        return answered;
      } catch (error) {
        await this.failAdjudication(binding, error);
        throw error;
      }
    }
    const parsed = escalationAnswerSchema.parse(input);
    const opened = this.#requireOpened({
      ...parsed,
      instanceId: binding.instance.instanceId,
    });
    const authority = {
      kind: "session",
      sessionKey: binding.sessionKey,
    } as const;
    return this.#answer(opened, parsed.answers, authority, parsed.prose);
  }

  async declineAdjudication(
    binding: WorkflowMcpSessionBinding,
    input: { reason: string; reasoning: string },
  ): Promise<void> {
    const occurrence = binding.adjudication;
    if (occurrence === undefined) {
      throw new TypeError("Only an adjudication session may decline");
    }
    const reason = input.reason.trim();
    const reasoning = input.reasoning.trim();
    if (reason === "" || reasoning === "") {
      throw new TypeError("Adjudication decline requires reason and reasoning");
    }
    await this.moveAnswerAuthority({
      adjudication: {
        cause: reason,
        modelSlug: occurrence.modelSlug,
        reasoning,
      },
      escalationId: occurrence.escalationId,
      instanceId: binding.instance.instanceId,
      ownerSessionKey: occurrence.ownerSessionKey,
      reason: `Adjudication declined: ${reason}`,
      to: { kind: "operator" },
    });
    await this.#adjudication?.stop({
      reason: "declined",
      sessionKey: binding.sessionKey,
    });
  }

  async failAdjudication(
    binding: WorkflowMcpSessionBinding,
    cause: unknown,
  ): Promise<void> {
    const occurrence = binding.adjudication;
    if (occurrence === undefined) return;
    const message = cause instanceof Error ? cause.message : String(cause);
    const opened = this.#history.find(
      binding.instance.instanceId,
      occurrence.ownerSessionKey,
      occurrence.escalationId,
    );
    if (
      opened.answered !== undefined ||
      opened.withdrawn ||
      opened.opened?.answeringAuthority.kind !== "adjudication" ||
      opened.opened.answeringAuthority.sessionKey !== binding.sessionKey
    ) {
      return;
    }
    await this.moveAnswerAuthority({
      adjudication: {
        cause: message,
        modelSlug: occurrence.modelSlug,
      },
      escalationId: occurrence.escalationId,
      instanceId: binding.instance.instanceId,
      ownerSessionKey: occurrence.ownerSessionKey,
      reason: `Adjudication failed: ${message}`,
      to: { kind: "operator" },
    });
    await this.#adjudication?.stop({
      reason: "failed",
      sessionKey: binding.sessionKey,
    });
  }

  async failAdjudicationForSession(input: {
    cause: unknown;
    instanceId: string;
    modelSlug: string;
    sessionKey: string;
  }): Promise<void> {
    const opened = this.#history
      .pending(input.instanceId)
      .find(
        ({ answeringAuthority }) =>
          answeringAuthority.kind === "adjudication" &&
          answeringAuthority.sessionKey === input.sessionKey,
      );
    if (opened === undefined) return;
    const message =
      input.cause instanceof Error ? input.cause.message : String(input.cause);
    await this.moveAnswerAuthority({
      adjudication: { cause: message, modelSlug: input.modelSlug },
      escalationId: opened.escalationId,
      instanceId: opened.instanceId,
      ownerSessionKey: opened.ownerSessionKey,
      reason: `Adjudication failed: ${message}`,
      to: { kind: "operator" },
    });
    await this.#adjudication?.stop({
      reason: "failed",
      sessionKey: input.sessionKey,
    });
  }

  async moveAnswerAuthority(input: {
    adjudication?: PendingEscalation["adjudication"];
    escalationId: string;
    instanceId: string;
    ownerSessionKey: string;
    reason: string;
    to: EscalationAnsweringAuthority;
  }): Promise<PendingEscalation> {
    const opened = this.#requireOpened(input);
    const moved = this.#history.moveAuthority(
      opened,
      input.to,
      input.reason,
      input.adjudication,
    );
    await this.#ensureRouted(moved);
    return moved;
  }

  async returnAnswerAuthorityToOperatorForSession(input: {
    instanceId: string;
    reason: string;
    sessionKey: string;
  }): Promise<void> {
    for (const opened of this.#history.pending(input.instanceId)) {
      if (
        opened.answeringAuthority.kind !== "session" ||
        opened.answeringAuthority.sessionKey !== input.sessionKey
      ) {
        continue;
      }
      await this.moveAnswerAuthority({
        escalationId: opened.escalationId,
        instanceId: opened.instanceId,
        ownerSessionKey: opened.ownerSessionKey,
        reason: input.reason,
        to: { kind: "operator" },
      });
    }
  }

  pendingEscalations(instanceId: string): PendingEscalation[] {
    return this.#history.pending(instanceId);
  }

  withdraw(opened: PendingEscalation): void {
    this.#history.withdraw(opened);
  }

  isAwaitingAnswer(instanceId: string, sessionKey: string): boolean {
    return this.pendingEscalations(instanceId).some(
      ({ ownerSessionKey }) => ownerSessionKey === sessionKey,
    );
  }

  async replayPendingRoutes(): Promise<void> {
    for (const { instanceId } of this.#persistence.listInstances()) {
      for (const opened of this.#history.pending(instanceId)) {
        await this.#ensureRouted(opened);
      }
      for (const opened of this.#history.withdrawn(instanceId)) {
        await this.#releaseWithdrawn(opened);
      }
    }
  }

  async #releaseWithdrawn(opened: PendingEscalation): Promise<void> {
    // Finish an in-flight start before cancelling its resulting session.
    const key = escalationKey(
      opened.instanceId,
      opened.ownerSessionKey,
      opened.escalationId,
    );
    await this.#routes.get(key)?.catch(() => undefined);
    if (
      this.#history.effectRecorded(
        opened,
        escalationEventTypes.withdrawalCompleted,
      )
    )
      return;
    await this.#attention.resolve?.(opened.attentionId);
    if (opened.answeringAuthority.kind === "adjudication") {
      const sessionKey = opened.answeringAuthority.sessionKey;
      if (
        this.#history
          .pending(opened.instanceId)
          .some(
            (question) =>
              question.ownerSessionKey === sessionKey ||
              (question.answeringAuthority.kind !== "operator" &&
                question.answeringAuthority.sessionKey === sessionKey),
          )
      )
        return;
      await this.#adjudication?.stop({ reason: "withdrawn", sessionKey });
    }
    this.#history.recordEffect(
      opened,
      escalationEventTypes.withdrawalCompleted,
    );
  }

  async replayPendingDeliveries(): Promise<void> {
    for (const { instanceId } of this.#persistence.listInstances()) {
      for (const { answered, opened } of this.#history.answered(instanceId)) {
        try {
          await this.#settle(opened, answered);
          await this.#settlementRecovered?.(opened);
        } catch (error) {
          if (await this.#containSettlementFailure?.(error, opened)) continue;
          throw error;
        }
      }
    }
  }

  requireNoPendingForSession(instanceId: string, sessionKey: string): void {
    if (
      this.pendingEscalations(instanceId).some(
        ({ ownerSessionKey, answeringAuthority }) =>
          ownerSessionKey === sessionKey ||
          (answeringAuthority.kind !== "operator" &&
            answeringAuthority.sessionKey === sessionKey),
      )
    ) {
      throw new Error(
        `Session '${sessionKey}' has a pending escalation and cannot stop`,
      );
    }
  }

  async resumeAfterNoPending<T>(
    instanceId: string,
    sessionKey: string,
    operationId: string,
    resume: () => Promise<T>,
  ): Promise<T> {
    while (true) {
      const current = this.#persistence.getInstance(instanceId);
      if (current === undefined) {
        throw new Error(`Instance does not exist: ${instanceId}`);
      }
      this.requireNoPendingForSession(instanceId, sessionKey);
      const existing = dispositionClaimFor(current.state, sessionKey);
      if (existing !== undefined) {
        if (existing !== operationId) {
          throw new Error(
            `Session '${sessionKey}' has another disposition claim`,
          );
        }
        break;
      }
      const claimed = this.#persistence.compareAndSwapInstance(
        instanceId,
        current.version,
        withDispositionClaim(current.state, sessionKey, operationId),
      );
      if (claimed !== undefined) break;
    }
    return resume();
  }

  #requireOpened(input: {
    escalationId: string;
    instanceId: string;
    ownerSessionKey: string;
  }): PendingEscalation {
    const opened = this.#history.find(
      input.instanceId,
      input.ownerSessionKey,
      input.escalationId,
    ).opened;
    if (opened === undefined) {
      throw new Error(`Escalation '${input.escalationId}' is not pending`);
    }
    return opened;
  }

  async #answer(
    opened: PendingEscalation,
    answers: EscalationAnswers,
    answeredBy: EscalationAnsweringAuthority,
    prose?: string,
    modelSlug?: string,
  ): Promise<AnsweredEscalation> {
    const answered = this.#history.answer(
      opened,
      answers,
      answeredBy,
      prose,
      modelSlug,
    );
    await this.#settle(opened, answered);
    return answered;
  }

  #settle(
    opened: PendingEscalation,
    answered: AnsweredEscalation,
  ): Promise<void> {
    const key = escalationKey(
      opened.instanceId,
      opened.ownerSessionKey,
      opened.escalationId,
    );
    const active = this.#settlements.get(key);
    if (active !== undefined) return active;
    const settlement = this.#recordAndDeliver(opened, answered).finally(() =>
      this.#settlements.delete(key),
    );
    this.#settlements.set(key, settlement);
    return settlement;
  }

  #ensureRouted(opened: PendingEscalation): Promise<void> {
    const key = escalationKey(
      opened.instanceId,
      opened.ownerSessionKey,
      opened.escalationId,
    );
    const active = this.#routes.get(key);
    if (active !== undefined) return active;
    const route = this.#route(opened).finally(() => this.#routes.delete(key));
    this.#routes.set(key, route);
    return route;
  }

  async #route(opened: PendingEscalation): Promise<void> {
    if (!this.#isPending(opened)) return;
    const types = this.#history.routeTypes(opened);
    if (opened.answeringAuthority.kind === "adjudication") {
      if (this.#adjudication === undefined) {
        throw new Error("Adjudication routing is not configured");
      }
      if (!types.has(escalationEventTypes.adjudicationStartIntended)) {
        this.#history.recordRoute(
          opened,
          escalationEventTypes.adjudicationStartIntended,
          { adjudicationSessionKey: opened.answeringAuthority.sessionKey },
        );
      }
      if (!types.has(escalationEventTypes.adjudicationStarted)) {
        try {
          const started = await this.#adjudication.start({
            ...opened,
            answeringAuthority: opened.answeringAuthority,
          });
          this.#history.recordRoute(
            opened,
            escalationEventTypes.adjudicationStarted,
            {
              adjudicationSessionKey: opened.answeringAuthority.sessionKey,
              modelSlug: started.modelSlug,
            },
          );
        } catch (error) {
          if (!this.#isPending(opened)) return;
          const cause = error instanceof Error ? error.message : String(error);
          const moved = this.#history.moveAuthority(
            opened,
            { kind: "operator" },
            `Adjudication could not start: ${cause}`,
            { cause },
          );
          await this.#routeOperator(moved);
        }
      }
      return;
    }
    if (opened.answeringAuthority.kind === "session") {
      if (
        !this.#history.sessionRouteRecorded(
          opened,
          opened.answeringAuthority.sessionKey,
        )
      ) {
        await this.#session.steer({
          ...opened,
          answeringAuthority: opened.answeringAuthority,
        });
        this.#history.recordRoute(opened, escalationEventTypes.sessionSteered, {
          answeringSessionKey: opened.answeringAuthority.sessionKey,
        });
      }
      return;
    }
    await this.#routeOperator(opened);
  }

  async #routeOperator(opened: PendingEscalation): Promise<void> {
    const types = this.#history.routeTypes(opened);
    const attention = attentionFrom(opened);
    if (!types.has(escalationEventTypes.attentionRaised)) {
      await this.#attention.raise(attention);
      this.#history.recordRoute(opened, escalationEventTypes.attentionRaised);
    }
    if (!this.#isPending(opened)) return;
    if (!types.has(escalationEventTypes.notified)) {
      try {
        await this.#pushover.send(attention);
      } catch (error) {
        if (await this.#containPushoverFailure?.(error, opened)) return;
        throw error;
      }
      this.#history.recordRoute(opened, escalationEventTypes.notified);
    }
  }

  #isPending(opened: PendingEscalation): boolean {
    const current = this.#history.find(
      opened.instanceId,
      opened.ownerSessionKey,
      opened.escalationId,
    );
    return (
      current.opened !== undefined &&
      current.answered === undefined &&
      !current.withdrawn
    );
  }

  async #recordAndDeliver(
    opened: PendingEscalation,
    answered: AnsweredEscalation,
  ): Promise<void> {
    if (
      !this.#history.effectRecorded(
        opened,
        escalationEventTypes.deliveryCompleted,
      )
    ) {
      const id = opened.attentionId.slice("escalation:".length);
      const stableUuid = (offset: number): string =>
        `${id.slice(offset, offset + 8)}-${id.slice(offset + 8, offset + 12)}-4${id.slice(offset + 13, offset + 16)}-a${id.slice(offset + 17, offset + 20)}-${id.slice(offset + 20, offset + 32)}`;
      await this.#delivery.deliver({
        answered,
        commandId: stableUuid(0),
        opened,
      });
      this.#history.recordEffect(
        opened,
        escalationEventTypes.deliveryCompleted,
      );
    }
    if (
      !this.#history.effectRecorded(
        opened,
        escalationEventTypes.decisionRecorded,
      )
    ) {
      await this.#decisionLog.record({ answered, opened });
      this.#history.recordEffect(opened, escalationEventTypes.decisionRecorded);
    }
  }
}

export {
  escalationAnswerSchema,
  escalationInputSchema,
  escalationQuestionSchema,
  type AnsweredEscalation,
  type EscalationAnswerInput,
  type EscalationAnsweringAuthority,
  type EscalationAnswers,
  type EscalationAttention,
  type EscalationInput,
  type EscalationQuestion,
  type EscalationResult,
  type ParentEscalation,
  type PendingEscalation,
  type SessionEscalation,
} from "./escalation-contract.js";
