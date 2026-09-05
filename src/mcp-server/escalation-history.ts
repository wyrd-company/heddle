// ---
// relationships:
//   implements: heddle
// ---

import type { JsonValue, PersistedEvent } from "../persistence/index.js";
import {
  escalationAnswerSchema,
  escalationAttentionId,
  escalationInputSchema,
  escalationKey,
  sameAnswers,
  sameQuestions,
  type AnsweredEscalation,
  type EscalationAnswers,
  type EscalationInput,
  type PendingEscalation,
  validateAnswers,
  validateQuestions,
} from "./escalation-contract.js";
import type {
  WorkflowMcpPersistence,
  WorkflowMcpSessionBinding,
} from "./types.js";
import { dispositionClaimFor } from "./session-disposition-claim.js";

export const escalationEventTypes = {
  answered: "mcp:escalation-answered",
  attentionRaised: "mcp:escalation-attention-raised",
  notified: "mcp:escalation-notified",
  opened: "mcp:escalation-opened",
  parentSteered: "mcp:escalation-parent-steered",
} as const;

export type EscalationRouteEventType =
  | typeof escalationEventTypes.attentionRaised
  | typeof escalationEventTypes.notified
  | typeof escalationEventTypes.parentSteered;

const eventPayload = (event: PersistedEvent): Record<string, JsonValue> => {
  if (
    typeof event.payload !== "object" ||
    event.payload === null ||
    Array.isArray(event.payload)
  ) {
    throw new Error(
      `Escalation event ${event.sequence} has an invalid payload`,
    );
  }
  return event.payload;
};

const openedFrom = (event: PersistedEvent): PendingEscalation => {
  const value = eventPayload(event);
  const parsed = escalationInputSchema.parse({
    escalationId: value["escalationId"],
    questions: value["questions"],
  });
  validateQuestions(parsed.questions);
  if (
    typeof value["attentionId"] !== "string" ||
    typeof value["openedAt"] !== "string" ||
    typeof value["ownerSessionKey"] !== "string" ||
    typeof value["stage"] !== "string" ||
    (value["parentSessionKey"] !== undefined &&
      typeof value["parentSessionKey"] !== "string")
  ) {
    throw new Error(
      `Escalation event ${event.sequence} has an invalid payload`,
    );
  }
  return {
    attentionId: value["attentionId"],
    escalationId: parsed.escalationId,
    instanceId: event.instanceId,
    openedAt: value["openedAt"],
    ownerSessionKey: value["ownerSessionKey"],
    ...(value["parentSessionKey"] === undefined
      ? {}
      : { parentSessionKey: value["parentSessionKey"] }),
    questions: parsed.questions,
    stage: value["stage"],
  };
};

const answeredFrom = (event: PersistedEvent): AnsweredEscalation => {
  const value = eventPayload(event);
  return escalationAnswerSchema.parse({
    answers: value["answers"],
    escalationId: value["escalationId"],
    ownerSessionKey: value["ownerSessionKey"],
  });
};

type ReplayedEscalation = {
  answered?: AnsweredEscalation;
  opened: PendingEscalation;
};

export class EscalationHistory {
  constructor(private readonly persistence: WorkflowMcpPersistence) {}

  open(
    binding: WorkflowMcpSessionBinding,
    input: EscalationInput,
    openedAt: string,
  ): {
    answered?: AnsweredEscalation;
    opened: PendingEscalation;
  } {
    const parsed = escalationInputSchema.parse(input);
    validateQuestions(parsed.questions);
    const opened: PendingEscalation = {
      attentionId: escalationAttentionId(
        binding.instance.instanceId,
        binding.sessionKey,
        parsed.escalationId,
      ),
      escalationId: parsed.escalationId,
      instanceId: binding.instance.instanceId,
      openedAt,
      ownerSessionKey: binding.sessionKey,
      ...(binding.parentSessionKey === undefined
        ? {}
        : { parentSessionKey: binding.parentSessionKey }),
      questions: parsed.questions,
      stage: binding.stage.id,
    };
    while (true) {
      const prior = this.find(
        binding.instance.instanceId,
        binding.sessionKey,
        parsed.escalationId,
      );
      if (
        prior.opened !== undefined &&
        !sameQuestions(prior.opened.questions, parsed.questions)
      ) {
        throw new TypeError(
          `Escalation '${parsed.escalationId}' was retried with different questions`,
        );
      }
      if (prior.opened !== undefined) {
        return { ...prior, opened: prior.opened };
      }
      const current = this.persistence.getInstance(binding.instance.instanceId);
      if (current === undefined) {
        throw new Error(
          `Instance does not exist: ${binding.instance.instanceId}`,
        );
      }
      const claimedSession = [binding.sessionKey, binding.parentSessionKey]
        .filter((sessionKey) => sessionKey !== undefined)
        .find(
          (sessionKey) =>
            dispositionClaimFor(current.state, sessionKey) !== undefined,
        );
      if (claimedSession !== undefined) {
        throw new Error(
          `Session '${claimedSession}' has claimed disposition authority`,
        );
      }
      const claimed = this.persistence.compareAndSwapInstanceWithEvent(
        binding.instance.instanceId,
        current.version,
        current.state,
        escalationEventTypes.opened,
        opened,
      );
      if (claimed !== undefined) return { opened };
    }
  }

  answer(
    opened: PendingEscalation,
    answers: EscalationAnswers,
  ): AnsweredEscalation {
    validateAnswers(opened, answers);
    const prior = this.find(
      opened.instanceId,
      opened.ownerSessionKey,
      opened.escalationId,
    ).answered;
    if (prior !== undefined) {
      if (!sameAnswers(opened, prior.answers, answers)) {
        throw new Error(
          `Escalation '${opened.escalationId}' is already answered differently`,
        );
      }
      return prior;
    }
    const answered = {
      answers,
      escalationId: opened.escalationId,
      ownerSessionKey: opened.ownerSessionKey,
    };
    this.persistence.appendEvent(
      opened.instanceId,
      escalationEventTypes.answered,
      answered,
    );
    return answered;
  }

  find(
    instanceId: string,
    ownerSessionKey: string,
    escalationId: string,
  ): { answered?: AnsweredEscalation; opened?: PendingEscalation } {
    return (
      this.#replay(instanceId).get(
        escalationKey(instanceId, ownerSessionKey, escalationId),
      ) ?? {}
    );
  }

  pending(instanceId: string): PendingEscalation[] {
    return [...this.#replay(instanceId).values()]
      .filter(({ answered }) => answered === undefined)
      .map(({ opened }) => opened);
  }

  #replay(instanceId: string): Map<string, ReplayedEscalation> {
    const replayed = new Map<string, ReplayedEscalation>();
    for (const event of this.persistence.replayEvents(instanceId)) {
      if (event.type === escalationEventTypes.opened) {
        const opened = openedFrom(event);
        const key = escalationKey(
          instanceId,
          opened.ownerSessionKey,
          opened.escalationId,
        );
        if (replayed.has(key)) {
          throw new Error(
            `Escalation '${opened.escalationId}' has more than one open event`,
          );
        }
        replayed.set(key, { opened });
      } else if (event.type === escalationEventTypes.answered) {
        const answered = answeredFrom(event);
        const key = escalationKey(
          instanceId,
          answered.ownerSessionKey,
          answered.escalationId,
        );
        const prior = replayed.get(key);
        if (prior === undefined) {
          throw new Error(
            `Escalation '${answered.escalationId}' answer precedes its open event`,
          );
        }
        validateAnswers(prior.opened, answered.answers);
        if (
          prior.answered !== undefined &&
          !sameAnswers(prior.opened, prior.answered.answers, answered.answers)
        ) {
          throw new Error(
            `Escalation '${answered.escalationId}' has conflicting answer events`,
          );
        }
        replayed.set(key, { ...prior, answered });
      }
    }
    return replayed;
  }

  routeTypes(opened: PendingEscalation): Set<string> {
    return new Set(
      this.persistence
        .replayEvents(opened.instanceId)
        .filter((event) => {
          if (!event.type.startsWith("mcp:escalation-")) return false;
          const value = eventPayload(event);
          return (
            value["ownerSessionKey"] === opened.ownerSessionKey &&
            value["escalationId"] === opened.escalationId
          );
        })
        .map(({ type }) => type),
    );
  }

  recordRoute(
    opened: PendingEscalation,
    type: EscalationRouteEventType,
    payload: Record<string, JsonValue> = {},
  ): void {
    this.persistence.appendEvent(opened.instanceId, type, {
      escalationId: opened.escalationId,
      ownerSessionKey: opened.ownerSessionKey,
      ...payload,
    });
  }
}
