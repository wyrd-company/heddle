// ---
// relationships:
//   implements: heddle
// ---

import type { JsonValue, PersistedEvent } from "../persistence/index.js";
import {
  answeredEscalationSchema,
  adjudicationEvidenceSchema,
  escalationAnsweringAuthoritySchema,
  escalationAttentionId,
  escalationInputSchema,
  escalationKey,
  sameAnswers,
  sameQuestions,
  type AnsweredEscalation,
  type EscalationAnsweringAuthority,
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
  authorityMoved: "mcp:escalation-authority-moved",
  adjudicationStarted: "mcp:escalation-adjudication-started",
  adjudicationStartIntended: "mcp:escalation-adjudication-start-intended",
  attentionRaised: "mcp:escalation-attention-raised",
  decisionRecorded: "mcp:escalation-decision-recorded",
  deliveryCompleted: "mcp:escalation-delivery-completed",
  notified: "mcp:escalation-notified",
  opened: "mcp:escalation-opened",
  parentSteered: "mcp:escalation-parent-steered",
  sessionSteered: "mcp:escalation-session-steered",
} as const;

export type EscalationRouteEventType =
  | typeof escalationEventTypes.adjudicationStarted
  | typeof escalationEventTypes.adjudicationStartIntended
  | typeof escalationEventTypes.attentionRaised
  | typeof escalationEventTypes.notified
  | typeof escalationEventTypes.parentSteered
  | typeof escalationEventTypes.sessionSteered;

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
    answeringAuthority:
      value["answeringAuthority"] === undefined
        ? value["parentSessionKey"] === undefined
          ? { kind: "operator" }
          : { kind: "session", sessionKey: value["parentSessionKey"] as string }
        : escalationAnsweringAuthoritySchema.parse(value["answeringAuthority"]),
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

const answeredFrom = (
  event: PersistedEvent,
  fallbackAuthority: EscalationAnsweringAuthority,
): AnsweredEscalation => {
  const value = eventPayload(event);
  return answeredEscalationSchema.parse({
    answers: value["answers"],
    answeredBy: value["answeredBy"] ?? fallbackAuthority,
    escalationId: value["escalationId"],
    ownerSessionKey: value["ownerSessionKey"],
    prose: value["prose"],
    modelSlug: value["modelSlug"],
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
    topLevelAuthority: EscalationAnsweringAuthority = { kind: "operator" },
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
      answeringAuthority:
        binding.parentSessionKey === undefined
          ? topLevelAuthority
          : { kind: "session", sessionKey: binding.parentSessionKey },
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
    answeredBy: EscalationAnsweringAuthority,
    prose?: string,
    modelSlug?: string,
  ): AnsweredEscalation {
    validateAnswers(opened, answers);
    const answered: AnsweredEscalation = {
      answers,
      answeredBy,
      escalationId: opened.escalationId,
      ownerSessionKey: opened.ownerSessionKey,
      ...(modelSlug === undefined ? {} : { modelSlug }),
      ...(prose === undefined ? {} : { prose }),
    };
    while (true) {
      const currentEscalation = this.find(
        opened.instanceId,
        opened.ownerSessionKey,
        opened.escalationId,
      );
      if (currentEscalation.opened === undefined) {
        throw new Error(`Escalation '${opened.escalationId}' is not pending`);
      }
      if (currentEscalation.answered !== undefined) {
        if (!sameAnswers(opened, currentEscalation.answered, answered)) {
          throw new Error(
            `Escalation '${opened.escalationId}' is already answered differently`,
          );
        }
        return currentEscalation.answered;
      }
      if (
        JSON.stringify(currentEscalation.opened.answeringAuthority) !==
        JSON.stringify(answeredBy)
      ) {
        throw new Error("The caller does not hold answering authority");
      }
      const current = this.persistence.getInstance(opened.instanceId);
      if (current === undefined) {
        throw new Error(`Instance does not exist: ${opened.instanceId}`);
      }
      const claimed = this.persistence.compareAndSwapInstanceWithEvent(
        opened.instanceId,
        current.version,
        current.state,
        escalationEventTypes.answered,
        answered,
      );
      if (claimed !== undefined) return answered;
    }
  }

  moveAuthority(
    opened: PendingEscalation,
    to: EscalationAnsweringAuthority,
    reason: string,
    adjudication?: PendingEscalation["adjudication"],
  ): PendingEscalation {
    if (reason.trim() === "") {
      throw new TypeError("Answering-authority move reason must not be empty");
    }
    while (true) {
      const currentEscalation = this.find(
        opened.instanceId,
        opened.ownerSessionKey,
        opened.escalationId,
      );
      if (currentEscalation.opened === undefined) {
        throw new Error(`Escalation '${opened.escalationId}' is not pending`);
      }
      if (currentEscalation.answered !== undefined) {
        throw new Error(
          `Escalation '${opened.escalationId}' is already answered`,
        );
      }
      if (
        JSON.stringify(currentEscalation.opened.answeringAuthority) ===
        JSON.stringify(to)
      ) {
        return currentEscalation.opened;
      }
      const current = this.persistence.getInstance(opened.instanceId);
      if (current === undefined) {
        throw new Error(`Instance does not exist: ${opened.instanceId}`);
      }
      const claimed = this.persistence.compareAndSwapInstanceWithEvent(
        opened.instanceId,
        current.version,
        current.state,
        escalationEventTypes.authorityMoved,
        {
          escalationId: opened.escalationId,
          from: currentEscalation.opened.answeringAuthority,
          ownerSessionKey: opened.ownerSessionKey,
          reason,
          to,
          ...(adjudication === undefined ? {} : { adjudication }),
        },
      );
      if (claimed !== undefined) {
        return {
          ...currentEscalation.opened,
          answeringAuthority: to,
          ...(adjudication === undefined ? {} : { adjudication }),
        };
      }
    }
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

  answered(instanceId: string): Array<{
    answered: AnsweredEscalation;
    opened: PendingEscalation;
  }> {
    return [...this.#replay(instanceId).values()].flatMap((entry) =>
      entry.answered === undefined
        ? []
        : [{ answered: entry.answered, opened: entry.opened }],
    );
  }

  effectRecorded(opened: PendingEscalation, type: string): boolean {
    return this.persistence.replayEvents(opened.instanceId).some((event) => {
      if (event.type !== type) return false;
      const value = eventPayload(event);
      return (
        value["ownerSessionKey"] === opened.ownerSessionKey &&
        value["escalationId"] === opened.escalationId
      );
    });
  }

  recordEffect(opened: PendingEscalation, type: string): void {
    if (this.effectRecorded(opened, type)) return;
    this.persistence.appendEvent(opened.instanceId, type, {
      escalationId: opened.escalationId,
      ownerSessionKey: opened.ownerSessionKey,
    });
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
      } else if (event.type === escalationEventTypes.authorityMoved) {
        const value = eventPayload(event);
        if (
          typeof value["ownerSessionKey"] !== "string" ||
          typeof value["escalationId"] !== "string" ||
          typeof value["reason"] !== "string" ||
          value["reason"].trim() === ""
        ) {
          throw new Error(
            `Escalation authority event ${event.sequence} has an invalid payload`,
          );
        }
        const key = escalationKey(
          instanceId,
          value["ownerSessionKey"],
          value["escalationId"],
        );
        const prior = replayed.get(key);
        if (prior === undefined || prior.answered !== undefined) {
          throw new Error(
            `Escalation '${value["escalationId"]}' authority move has no pending open event`,
          );
        }
        const from = escalationAnsweringAuthoritySchema.parse(value["from"]);
        if (
          JSON.stringify(from) !==
          JSON.stringify(prior.opened.answeringAuthority)
        ) {
          throw new Error(
            `Escalation '${value["escalationId"]}' authority move disagrees with current authority`,
          );
        }
        replayed.set(key, {
          opened: {
            ...prior.opened,
            answeringAuthority: escalationAnsweringAuthoritySchema.parse(
              value["to"],
            ),
            ...(value["adjudication"] === undefined
              ? {}
              : {
                  adjudication: adjudicationEvidenceSchema.parse(
                    value["adjudication"],
                  ),
                }),
          },
        });
      } else if (event.type === escalationEventTypes.answered) {
        const value = eventPayload(event);
        if (
          typeof value["ownerSessionKey"] !== "string" ||
          typeof value["escalationId"] !== "string"
        ) {
          throw new Error(
            `Escalation event ${event.sequence} has an invalid payload`,
          );
        }
        const key = escalationKey(
          instanceId,
          value["ownerSessionKey"],
          value["escalationId"],
        );
        const prior = replayed.get(key);
        if (prior === undefined) {
          throw new Error(
            `Escalation '${value["escalationId"]}' answer precedes its open event`,
          );
        }
        const answered = answeredFrom(event, prior.opened.answeringAuthority);
        validateAnswers(prior.opened, answered.answers);
        if (
          prior.answered !== undefined &&
          !sameAnswers(prior.opened, prior.answered, answered)
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

  sessionRouteRecorded(opened: PendingEscalation, sessionKey: string): boolean {
    return this.persistence.replayEvents(opened.instanceId).some((event) => {
      if (
        event.type !== escalationEventTypes.sessionSteered &&
        event.type !== escalationEventTypes.parentSteered
      ) {
        return false;
      }
      const value = eventPayload(event);
      return (
        value["ownerSessionKey"] === opened.ownerSessionKey &&
        value["escalationId"] === opened.escalationId &&
        (value["answeringSessionKey"] === sessionKey ||
          value["parentSessionKey"] === sessionKey)
      );
    });
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
