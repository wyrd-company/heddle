// ---
// relationships:
//   implements: heddle
// ---

import {
  assertConsoleAttentionFingerprint,
  parseConsoleAttentionActionRequest,
  type ConsoleAttentionAction,
  type ConsoleAttentionActionAnswers,
  type ConsoleAttentionActionPort,
} from "../console/index.js";
import type { SessionObserver } from "../control-plane/index.js";
import type {
  EscalationAnswers,
  EscalationCoordinator,
} from "../mcp-server/index.js";
import type { JsonValue, SqlitePersistence } from "../persistence/index.js";
import type { DurableAttentionQueue } from "./durable-adapters.js";
import { schedulerPassAttentionId } from "./scheduler-pass-attention.js";
import {
  incidentProductionMutationApproved,
  incidentProposalDigest,
} from "./incident-approval.js";

const effectKind = "console-attention-action";

const actionStableId = (
  attentionId: string,
  action: ConsoleAttentionAction,
): string => {
  const contract = action.contract;
  return contract.kind === "attention.resolve" &&
    contract.schedulerFailureSequence !== undefined
    ? `${attentionId}:scheduler-failure:${contract.schedulerFailureSequence}`
    : attentionId;
};

const canonicalAnswers = (
  answers: ConsoleAttentionActionAnswers | undefined,
): ConsoleAttentionActionAnswers | undefined =>
  answers === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(answers).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      );

const actionIntent = (
  action: ConsoleAttentionAction,
  answers: ConsoleAttentionActionAnswers | undefined,
): JsonValue =>
  JSON.parse(
    JSON.stringify({ action, answers: canonicalAnswers(answers) ?? null }),
  ) as JsonValue;

const escalationAnswers = (
  answers: ConsoleAttentionActionAnswers | undefined,
): EscalationAnswers => {
  if (
    answers === undefined ||
    Object.values(answers).some((answer) => typeof answer !== "string")
  ) {
    throw new TypeError("Escalation answers must select one option each");
  }
  return answers as EscalationAnswers;
};

export class ProductionAttentionActions implements ConsoleAttentionActionPort {
  public constructor(
    private readonly persistence: SqlitePersistence,
    private readonly attention: DurableAttentionQueue,
    private readonly escalation: EscalationCoordinator,
    private readonly observer: SessionObserver,
  ) {}

  async execute(input: Parameters<ConsoleAttentionActionPort["execute"]>[0]) {
    assertConsoleAttentionFingerprint(input.attention);
    const offered = input.attention.actions.find(
      ({ actionId }) => actionId === input.action.actionId,
    );
    if (
      offered === undefined ||
      JSON.stringify(offered) !== JSON.stringify(input.action)
    ) {
      throw new Error(
        `Attention '${input.attention.attentionId}' does not offer action '${input.action.actionId}'`,
      );
    }
    const request = parseConsoleAttentionActionRequest(
      {
        ...(input.answers === undefined ? {} : { answers: input.answers }),
        fingerprint: input.attention.fingerprint,
      },
      input.action,
    );
    const validated = {
      ...input,
      ...(request.answers === undefined ? {} : { answers: request.answers }),
    };
    const intent = actionIntent(input.action, request.answers);
    if (!this.#schedulerResolutionIsCurrent(validated)) return;
    const stableId = actionStableId(input.attention.attentionId, input.action);
    this.persistence.recordEffectIntent(effectKind, stableId, intent);
    if (!this.persistence.effectCompleted(effectKind, stableId)) {
      if (!(await this.#effectRecorded(validated))) {
        await this.#apply(validated);
      }
      this.#recordAcceptedApproval(validated);
      if (
        !this.persistence.recordEffectCompleted(effectKind, stableId) &&
        !this.persistence.effectCompleted(effectKind, stableId)
      ) {
        throw new Error("Attention action completion lost its durable intent");
      }
    }
    if (!this.#schedulerResolutionIsCurrent(validated)) return;
    this.attention.resolve(input.attention.attentionId);
  }

  #recordAcceptedApproval(
    input: Parameters<ConsoleAttentionActionPort["execute"]>[0],
  ): void {
    const contract = input.action.contract;
    if (
      contract.kind !== "t3.approval.respond" ||
      contract.decision !== "accept"
    ) {
      return;
    }
    const alreadyRecorded = this.persistence
      .replayEvents(contract.instanceId)
      .some(
        ({ payload, type }) =>
          type === "operator:approval-accepted" &&
          typeof payload === "object" &&
          payload !== null &&
          !Array.isArray(payload) &&
          payload["requestId"] === contract.requestId &&
          payload["sessionKey"] === contract.sessionKey,
      );
    if (alreadyRecorded) return;
    this.persistence.appendEvent(
      contract.instanceId,
      "operator:approval-accepted",
      {
        attentionId: input.attention.attentionId,
        requestId: contract.requestId,
        sessionKey: contract.sessionKey,
      },
    );
  }

  #schedulerResolutionIsCurrent(
    input: Parameters<ConsoleAttentionActionPort["execute"]>[0],
  ): boolean {
    if (input.action.contract.kind !== "attention.resolve") return true;
    const current = this.persistence
      .listAttention()
      .find(
        (record) =>
          record.attentionId === input.attention.attentionId &&
          schedulerPassAttentionId(record) !== undefined,
      );
    if (current === undefined) return true;
    return (
      input.action.contract.schedulerFailureSequence ===
      this.persistence.currentSchedulerPassFailureSequence()
    );
  }

  async #effectRecorded(
    input: Parameters<ConsoleAttentionActionPort["execute"]>[0],
  ): Promise<boolean> {
    const contract = input.action.contract;
    if (contract.kind === "attention.resolve") return false;
    if (contract.kind === "incident.production-mutation.approve") {
      const runtime = this.persistence
        .listIncidentRuntime()
        .find(({ incidentId }) => incidentId === contract.instanceId);
      return (
        runtime !== undefined &&
        incidentProductionMutationApproved(this.persistence, runtime)
      );
    }
    if (contract.kind === "notification.retry") {
      const failure = this.#notificationFailure(
        input.attention.attentionId,
        contract.occurrence,
      );
      return failure !== undefined && failure.state === "retry-authorized";
    }
    if (contract.kind === "escalation.answer") return false;
    const target = {
      instanceId: contract.instanceId,
      sessionKey: contract.sessionKey,
      threadId: contract.threadId,
    };
    if (contract.kind === "t3.approval.respond") {
      return this.observer.approvalResponseRecorded(
        target,
        contract.requestId,
        contract.decision,
      );
    }
    return this.observer.userInputResponseRecorded(
      target,
      contract.requestId,
      input.answers!,
    );
  }

  async #apply(input: Parameters<ConsoleAttentionActionPort["execute"]>[0]) {
    const contract = input.action.contract;
    if (contract.kind === "attention.resolve") return;
    if (contract.kind === "incident.production-mutation.approve") {
      const runtime = this.persistence
        .listIncidentRuntime()
        .find(({ incidentId }) => incidentId === contract.instanceId);
      if (
        runtime === undefined ||
        !runtime.accepted ||
        incidentProposalDigest(runtime) !== contract.proposalDigest
      ) {
        throw new Error(
          "Incident production mutation proposal is no longer current",
        );
      }
      this.persistence.appendEvent(
        runtime.incidentId,
        "operator:incident-production-mutation-approved",
        {
          attentionId: input.attention.attentionId,
          proposalDigest: contract.proposalDigest,
        },
      );
      return;
    }
    if (contract.kind === "notification.retry") {
      const failure = this.#notificationFailure(
        input.attention.attentionId,
        contract.occurrence,
      );
      if (
        failure === undefined ||
        failure.recipientLabel === null ||
        failure.message === null ||
        !this.persistence.authorizeNotificationRetry(
          failure.stableId,
          contract.occurrence,
        )
      ) {
        throw new Error(
          "Notification rejection occurrence is no longer current",
        );
      }
      return;
    }
    if (contract.kind === "escalation.answer") {
      this.escalation.answerAsOperator({
        answers: escalationAnswers(input.answers),
        escalationId: contract.escalationId,
        instanceId: contract.instanceId,
        ownerSessionKey: contract.ownerSessionKey,
      });
      return;
    }
    if (contract.kind === "t3.approval.respond") {
      await this.observer.answerApproval(
        {
          instanceId: contract.instanceId,
          sessionKey: contract.sessionKey,
          threadId: contract.threadId,
        },
        contract.requestId,
        contract.decision,
        input.attention.attentionId,
      );
      return;
    }
    await this.observer.answerUserInput(
      {
        instanceId: contract.instanceId,
        sessionKey: contract.sessionKey,
        threadId: contract.threadId,
      },
      contract.requestId,
      input.answers!,
      input.attention.attentionId,
    );
  }

  #notificationFailure(attentionId: string, occurrence: number) {
    const record = this.persistence
      .listAttention()
      .find((candidate) => candidate.attentionId === attentionId);
    const payload = record?.payload;
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload) ||
      payload["kind"] !== "production-error" ||
      (payload["code"] !== "notification-delivery-rejected" &&
        payload["code"] !== "notification-delivery-recovery-required") ||
      typeof payload["notificationStableId"] !== "string" ||
      payload["notificationOccurrence"] !== occurrence
    ) {
      return undefined;
    }
    const failure = this.persistence.notificationFailure(
      payload["notificationStableId"],
    );
    return failure?.occurrence === occurrence ? failure : undefined;
  }
}
