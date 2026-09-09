// ---
// relationships:
//   implements: heddle
// ---

import {
  escalationAnswerSchema,
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
}

export interface PushoverEscalationNotifier {
  send(attention: EscalationAttention): Promise<void>;
}

export interface SessionEscalationRouter {
  steer(escalation: SessionEscalation): Promise<void>;
}

export interface EscalationAnswerDelivery {
  deliver(input: {
    answered: AnsweredEscalation;
    commandId: string;
    message: string;
    messageId: string;
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
  attention: EscalationAttentionQueue;
  containPushoverFailure?: (
    error: unknown,
    escalation: PendingEscalation,
  ) => Promise<boolean> | boolean;
  decisionLog: EscalationDecisionLog;
  delivery: EscalationAnswerDelivery;
  now?: () => string;
  session: SessionEscalationRouter;
  persistence: WorkflowMcpPersistence;
  pushover: PushoverEscalationNotifier;
};

export class EscalationCoordinator {
  readonly #attention: EscalationAttentionQueue;
  readonly #containPushoverFailure?: EscalationCoordinatorOptions["containPushoverFailure"];
  readonly #history: EscalationHistory;
  readonly #decisionLog: EscalationDecisionLog;
  readonly #delivery: EscalationAnswerDelivery;
  readonly #now: () => string;
  readonly #session: SessionEscalationRouter;
  readonly #persistence: WorkflowMcpPersistence;
  readonly #pushover: PushoverEscalationNotifier;
  readonly #routes = new Map<string, Promise<void>>();
  readonly #settlements = new Map<string, Promise<void>>();

  constructor(options: EscalationCoordinatorOptions) {
    this.#attention = options.attention;
    this.#containPushoverFailure = options.containPushoverFailure;
    this.#history = new EscalationHistory(options.persistence);
    this.#decisionLog = options.decisionLog;
    this.#delivery = options.delivery;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#session = options.session;
    this.#persistence = options.persistence;
    this.#pushover = options.pushover;
  }

  async escalate(
    binding: WorkflowMcpSessionBinding,
    input: EscalationInput,
  ): Promise<EscalationResult> {
    const history = this.#history.open(binding, input, this.#now());
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
    this.#requireAnswerAuthority(opened, authority);
    return this.#answer(opened, input.answers, authority, input.prose);
  }

  async answerAsSession(
    binding: WorkflowMcpSessionBinding,
    input: EscalationAnswerInput,
  ): Promise<AnsweredEscalation> {
    const parsed = escalationAnswerSchema.parse(input);
    const opened = this.#requireOpened({
      ...parsed,
      instanceId: binding.instance.instanceId,
    });
    const authority = {
      kind: "session",
      sessionKey: binding.sessionKey,
    } as const;
    this.#requireAnswerAuthority(opened, authority);
    return this.#answer(opened, parsed.answers, authority, parsed.prose);
  }

  async moveAnswerAuthority(input: {
    escalationId: string;
    instanceId: string;
    ownerSessionKey: string;
    reason: string;
    to: EscalationAnsweringAuthority;
  }): Promise<PendingEscalation> {
    const opened = this.#requireOpened(input);
    const moved = this.#history.moveAuthority(opened, input.to, input.reason);
    await this.#ensureRouted(moved);
    return moved;
  }

  pendingEscalations(instanceId: string): PendingEscalation[] {
    return this.#history.pending(instanceId);
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
    }
  }

  async replayPendingDeliveries(): Promise<void> {
    for (const { instanceId } of this.#persistence.listInstances()) {
      for (const { answered, opened } of this.#history.answered(instanceId)) {
        await this.#settle(opened, answered);
      }
    }
  }

  requireNoPendingForSession(instanceId: string, sessionKey: string): void {
    if (
      this.pendingEscalations(instanceId).some(
        ({ ownerSessionKey, parentSessionKey }) =>
          ownerSessionKey === sessionKey || parentSessionKey === sessionKey,
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
  ): Promise<AnsweredEscalation> {
    const answered = this.#history.answer(opened, answers, answeredBy, prose);
    await this.#settle(opened, answered);
    return answered;
  }

  #requireAnswerAuthority(
    opened: PendingEscalation,
    caller: EscalationAnsweringAuthority,
  ): void {
    if (JSON.stringify(opened.answeringAuthority) !== JSON.stringify(caller)) {
      throw new Error("The caller does not hold answering authority");
    }
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
    const types = this.#history.routeTypes(opened);
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
    if (!types.has(escalationEventTypes.attentionRaised)) {
      await this.#attention.raise(opened);
      this.#history.recordRoute(opened, escalationEventTypes.attentionRaised);
    }
    if (!types.has(escalationEventTypes.notified)) {
      try {
        await this.#pushover.send(opened);
      } catch (error) {
        if (await this.#containPushoverFailure?.(error, opened)) return;
        throw error;
      }
      this.#history.recordRoute(opened, escalationEventTypes.notified);
    }
  }

  async #recordAndDeliver(
    opened: PendingEscalation,
    answered: AnsweredEscalation,
  ): Promise<void> {
    if (
      !this.#history.effectRecorded(
        opened,
        escalationEventTypes.decisionRecorded,
      )
    ) {
      await this.#decisionLog.record({ answered, opened });
      this.#history.recordEffect(opened, escalationEventTypes.decisionRecorded);
    }
    if (
      this.#history.effectRecorded(
        opened,
        escalationEventTypes.deliveryCompleted,
      )
    ) {
      return;
    }
    const id = opened.attentionId.slice("escalation:".length);
    const stableUuid = (offset: number): string =>
      `${id.slice(offset, offset + 8)}-${id.slice(offset + 8, offset + 12)}-4${id.slice(offset + 13, offset + 16)}-a${id.slice(offset + 17, offset + 20)}-${id.slice(offset + 20, offset + 32)}`;
    await this.#delivery.deliver({
      answered,
      commandId: stableUuid(0),
      message: this.#deliveryMessage(opened, answered),
      messageId: stableUuid(32),
      opened,
    });
    this.#history.recordEffect(opened, escalationEventTypes.deliveryCompleted);
  }

  #deliveryMessage(
    opened: PendingEscalation,
    answered: AnsweredEscalation,
  ): string {
    const answers = opened.questions.map((question) => {
      const value = answered.answers[question.id]!;
      const rendered =
        question.kind === "value"
          ? value
          : `${question.options.find(({ id }) => id === value)!.label} (${value})`;
      return `Question: ${question.prompt}\nAnswer: ${rendered}`;
    });
    return [
      `Escalation ${opened.escalationId} was answered.`,
      ...answers,
      ...(answered.prose === undefined
        ? []
        : [`Additional context: ${answered.prose}`]),
      "Continue the stage using this answer.",
    ].join("\n\n");
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
