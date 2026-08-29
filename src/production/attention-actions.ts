// ---
// relationships:
//   implements: heddle
// ---

import {
  assertConsoleAttentionFingerprint,
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
  actionId: string,
  answers: ConsoleAttentionActionAnswers | undefined,
): JsonValue =>
  JSON.parse(
    JSON.stringify({ actionId, answers: canonicalAnswers(answers) ?? null }),
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
    const intent = actionIntent(input.action.actionId, input.answers);
    this.persistence.recordEffectIntent(
      effectKind,
      input.attention.attentionId,
      intent,
    );
    if (
      !this.persistence.effectCompleted(effectKind, input.attention.attentionId)
    ) {
      await this.#apply(input);
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
      if (input.answers !== undefined) {
        throw new TypeError("Approval actions do not accept answers");
      }
      await this.observer.answerApproval(
        {
          instanceId: contract.instanceId,
          sessionKey: contract.sessionKey,
          threadId: contract.threadId,
        },
        contract.requestId,
        contract.decision,
      );
      return;
    }
    if (input.answers === undefined) {
      throw new TypeError("User-input actions require answers");
    }
    await this.observer.answerUserInput(
      {
        instanceId: contract.instanceId,
        sessionKey: contract.sessionKey,
        threadId: contract.threadId,
      },
      contract.requestId,
      input.answers,
    );
  }
}
