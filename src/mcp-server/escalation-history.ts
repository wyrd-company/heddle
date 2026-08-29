// ---
// relationships:
//   implements: heddle
// ---

import type { JsonValue, PersistedEvent } from "../persistence/index.js";
import {
  escalationAnswerSchema,
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
    if (prior.opened !== undefined) return { ...prior, opened: prior.opened };
    const opened: PendingEscalation = {
      attentionId: escalationKey(
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
    this.persistence.appendEvent(
      binding.instance.instanceId,
      escalationEventTypes.opened,
      opened,
    );
    return { opened };
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
    let opened: PendingEscalation | undefined;
    let answered: AnsweredEscalation | undefined;
    for (const event of this.persistence.replayEvents(instanceId)) {
      if (event.type === escalationEventTypes.opened) {
        const value = openedFrom(event);
        if (
          value.ownerSessionKey === ownerSessionKey &&
          value.escalationId === escalationId
        ) {
          opened = value;
        }
      } else if (event.type === escalationEventTypes.answered) {
        const value = answeredFrom(event);
        if (
          value.ownerSessionKey === ownerSessionKey &&
          value.escalationId === escalationId
        ) {
          answered = value;
        }
      }
    }
    if (opened !== undefined && answered !== undefined) {
      validateAnswers(opened, answered.answers);
    }
    return {
      ...(answered === undefined ? {} : { answered }),
      ...(opened === undefined ? {} : { opened }),
    };
  }

  pending(instanceId: string): PendingEscalation[] {
    const opened = new Map<string, PendingEscalation>();
    const answered = new Map<string, AnsweredEscalation>();
    for (const event of this.persistence.replayEvents(instanceId)) {
      if (event.type === escalationEventTypes.opened) {
        const value = openedFrom(event);
        opened.set(
          escalationKey(instanceId, value.ownerSessionKey, value.escalationId),
          value,
        );
      } else if (event.type === escalationEventTypes.answered) {
        const value = answeredFrom(event);
        answered.set(
          escalationKey(instanceId, value.ownerSessionKey, value.escalationId),
          value,
        );
      }
    }
    for (const [key, value] of answered) {
      const pending = opened.get(key);
      if (pending === undefined) continue;
      validateAnswers(pending, value.answers);
      opened.delete(key);
    }
    return [...opened.values()];
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
