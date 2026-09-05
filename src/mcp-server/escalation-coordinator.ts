// ---
// relationships:
//   implements: heddle
// ---

import {
  escalationAnswerSchema,
  escalationKey,
  type AnsweredEscalation,
  type EscalationAnswerInput,
  type EscalationAnswers,
  type EscalationAttention,
  type EscalationInput,
  type EscalationResult,
  type ParentEscalation,
  type PendingEscalation,
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

export interface ParentEscalationRouter {
  steer(escalation: ParentEscalation): Promise<void>;
}

export type EscalationCoordinatorOptions = {
  attention: EscalationAttentionQueue;
  containPushoverFailure?: (
    error: unknown,
    escalation: PendingEscalation,
  ) => Promise<boolean> | boolean;
  now?: () => string;
  parent: ParentEscalationRouter;
  persistence: WorkflowMcpPersistence;
  pushover: PushoverEscalationNotifier;
};

type Waiter = {
  reject(error: unknown): void;
  resolve(answer: AnsweredEscalation): void;
};

export class EscalationCoordinator {
  readonly #attention: EscalationAttentionQueue;
  readonly #containPushoverFailure?: EscalationCoordinatorOptions["containPushoverFailure"];
  readonly #history: EscalationHistory;
  readonly #now: () => string;
  readonly #parent: ParentEscalationRouter;
  readonly #persistence: WorkflowMcpPersistence;
  readonly #pushover: PushoverEscalationNotifier;
  readonly #routes = new Map<string, Promise<void>>();
  readonly #waiters = new Map<string, Set<Waiter>>();

  constructor(options: EscalationCoordinatorOptions) {
    this.#attention = options.attention;
    this.#containPushoverFailure = options.containPushoverFailure;
    this.#history = new EscalationHistory(options.persistence);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#parent = options.parent;
    this.#persistence = options.persistence;
    this.#pushover = options.pushover;
  }

  async escalate(
    binding: WorkflowMcpSessionBinding,
    input: EscalationInput,
    signal?: globalThis.AbortSignal,
  ): Promise<EscalationResult> {
    const history = this.#history.open(binding, input, this.#now());
    if (history.answered !== undefined) {
      return this.#result(history.answered);
    }
    await this.#ensureRouted(history.opened);
    const answered = this.#history.find(
      binding.instance.instanceId,
      binding.sessionKey,
      input.escalationId,
    ).answered;
    return this.#result(answered ?? (await this.#wait(history.opened, signal)));
  }

  answerAsOperator(input: {
    answers: EscalationAnswers;
    escalationId: string;
    instanceId: string;
    ownerSessionKey: string;
  }): AnsweredEscalation {
    const opened = this.#requireOpened(input);
    if (opened.parentSessionKey !== undefined) {
      throw new Error(
        "A child escalation must be answered by its parent session",
      );
    }
    return this.#answer(opened, input.answers);
  }

  answerAsSession(
    binding: WorkflowMcpSessionBinding,
    input: EscalationAnswerInput,
  ): AnsweredEscalation {
    const parsed = escalationAnswerSchema.parse(input);
    const opened = this.#requireOpened({
      ...parsed,
      instanceId: binding.instance.instanceId,
    });
    if (opened.parentSessionKey !== binding.sessionKey) {
      throw new Error("The caller is not the parent of this escalation");
    }
    return this.#answer(opened, parsed.answers);
  }

  pendingEscalations(instanceId: string): PendingEscalation[] {
    return this.#history.pending(instanceId);
  }

  async replayPendingRoutes(): Promise<void> {
    for (const { instanceId } of this.#persistence.listInstances()) {
      for (const opened of this.#history.pending(instanceId)) {
        await this.#ensureRouted(opened);
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

  #result(answered: AnsweredEscalation): EscalationResult {
    return {
      answers: answered.answers,
      escalationId: answered.escalationId,
    };
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

  #answer(
    opened: PendingEscalation,
    answers: EscalationAnswers,
  ): AnsweredEscalation {
    const answered = this.#history.answer(opened, answers);
    const key = escalationKey(
      opened.instanceId,
      opened.ownerSessionKey,
      opened.escalationId,
    );
    const waiters = this.#waiters.get(key);
    this.#waiters.delete(key);
    for (const waiter of waiters ?? []) waiter.resolve(answered);
    return answered;
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
    if (opened.parentSessionKey !== undefined) {
      if (!types.has(escalationEventTypes.parentSteered)) {
        await this.#parent.steer({
          ...opened,
          parentSessionKey: opened.parentSessionKey,
        });
        this.#history.recordRoute(opened, escalationEventTypes.parentSteered, {
          parentSessionKey: opened.parentSessionKey,
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

  #wait(
    opened: PendingEscalation,
    signal?: globalThis.AbortSignal,
  ): Promise<AnsweredEscalation> {
    const key = escalationKey(
      opened.instanceId,
      opened.ownerSessionKey,
      opened.escalationId,
    );
    return new Promise<AnsweredEscalation>((resolve, reject) => {
      const waiters = this.#waiters.get(key) ?? new Set<Waiter>();
      const waiter: Waiter = {
        reject,
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
      };
      const onAbort = (): void => {
        waiters.delete(waiter);
        if (waiters.size === 0) this.#waiters.delete(key);
        reject(signal?.reason ?? new Error("Escalation call was cancelled"));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      waiters.add(waiter);
      this.#waiters.set(key, waiters);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export {
  escalationAnswerSchema,
  escalationInputSchema,
  escalationQuestionSchema,
  type AnsweredEscalation,
  type EscalationAnswerInput,
  type EscalationAnswers,
  type EscalationAttention,
  type EscalationInput,
  type EscalationQuestion,
  type EscalationResult,
  type ParentEscalation,
  type PendingEscalation,
} from "./escalation-contract.js";
