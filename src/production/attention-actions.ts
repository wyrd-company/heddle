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

const effectKind = "console-attention-action";

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
    this.persistence.recordEffectIntent(
      effectKind,
      input.attention.attentionId,
      intent,
    );
    if (
      !this.persistence.effectCompleted(effectKind, input.attention.attentionId)
    ) {
      if (!(await this.#effectRecorded(validated))) {
        await this.#apply(validated);
      }
      if (
        !this.persistence.recordEffectCompleted(
          effectKind,
          input.attention.attentionId,
        ) &&
        !this.persistence.effectCompleted(
          effectKind,
          input.attention.attentionId,
        )
      ) {
        throw new Error("Attention action completion lost its durable intent");
      }
    }
    this.attention.resolve(input.attention.attentionId);
  }

  async #effectRecorded(
    input: Parameters<ConsoleAttentionActionPort["execute"]>[0],
  ): Promise<boolean> {
    const contract = input.action.contract;
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
}
