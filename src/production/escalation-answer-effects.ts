// ---
// relationships:
//   implements: heddle
// ---

import {
  escalationKey,
  type AnsweredEscalation,
  type EscalationAnswerDelivery,
  type EscalationDecisionLog,
  type PendingEscalation,
} from "../mcp-server/index.js";
import type { SqlitePersistence } from "../persistence/index.js";
import type { KanbanBoardAdapter } from "../board-adapter/index.js";
import { harnessAnswers } from "../mcp-server/escalation-contract.js";
import { userInputResponseRecorded } from "../control-plane/session-response-reconciliation.js";
import type { ProductionT3Client } from "./composition.js";
import { productionSessionBindingFor } from "./subagent-composition.js";

const answerLines = (
  opened: PendingEscalation,
  answered: AnsweredEscalation,
): string[] =>
  opened.questions.flatMap((question) => {
    const answer = answered.answers[question.id]!;
    const selected =
      answer.text.trim() === ""
        ? answer.selectedOptions.join(", ")
        : answer.text;
    return [
      `- Question: ${question.question}`,
      `  Answer: ${selected}`,
      `  Reasoning: ${answer.reasoning}`,
    ];
  });

const authorityName = (answered: AnsweredEscalation): string =>
  answered.answeredBy.kind === "operator"
    ? "operator"
    : `session:${answered.answeredBy.sessionKey}`;

const decisionActivity = (
  opened: PendingEscalation,
  answered: AnsweredEscalation,
): string =>
  [
    "**ESCALATION ANSWERED**",
    ...answerLines(opened, answered),
    ...(answered.prose === undefined ? [] : [`- Prose: ${answered.prose}`]),
    `- Answering authority: ${authorityName(answered)}`,
    "---",
  ].join("\n");

export class ProductionEscalationAnswerEffects
  implements EscalationAnswerDelivery, EscalationDecisionLog
{
  public constructor(
    private readonly persistence: SqlitePersistence,
    private readonly board: Pick<
      KanbanBoardAdapter,
      "appendTaskActivity" | "readTask"
    >,
    private readonly t3: ProductionT3Client,
  ) {}

  async record(input: {
    answered: AnsweredEscalation;
    opened: PendingEscalation;
  }): Promise<void> {
    const task = await this.#taskFor(input.opened.instanceId);
    const activity = decisionActivity(input.opened, input.answered);
    const operation = escalationKey(
      input.opened.instanceId,
      input.opened.ownerSessionKey,
      input.opened.escalationId,
    );
    await this.board.appendTaskActivity(
      task.id,
      `${operation}:task:${task.id}`,
      activity,
    );
    if (task.parent !== undefined) {
      await this.board.appendTaskActivity(
        task.parent,
        `${operation}:epic:${task.parent}`,
        activity,
      );
    }
  }

  async deliver(input: {
    answered: AnsweredEscalation;
    commandId: string;
    opened: PendingEscalation;
  }): Promise<void> {
    const binding = this.#currentDeliveryBinding(input.opened);
    if (binding.threadId !== input.opened.threadId) {
      throw new Error("Question reply cannot target a replacement thread");
    }
    if (
      !(await this.t3.getShell()).threads.some(
        (thread) =>
          thread.id === input.opened.threadId &&
          thread.session?.status !== "error" &&
          thread.latestTurn?.state !== "error",
      )
    ) {
      throw new Error(
        `Escalation owner session '${input.opened.ownerSessionKey}' is unavailable`,
      );
    }
    const wireAnswers = harnessAnswers(
      input.opened.questions,
      input.answered.answers,
    );
    if (
      userInputResponseRecorded(
        await this.t3.getThread(input.opened.threadId),
        input.opened.requestId,
        wireAnswers,
      )
    )
      return;
    await this.t3.respondToUserInput(
      input.opened.threadId,
      input.opened.requestId,
      wireAnswers,
      input.commandId,
    );
  }

  #currentDeliveryBinding(opened: PendingEscalation) {
    return productionSessionBindingFor(
      this.persistence,
      opened.ownerSessionKey,
    );
  }

  async #taskFor(instanceId: string) {
    const runtime = this.persistence
      .listReconcilerRuntime()
      .find((candidate) => candidate.instanceId === instanceId);
    const incident = this.persistence
      .listIncidentRuntime()
      .find((candidate) => candidate.incidentId === instanceId);
    if ((runtime === undefined) === (incident === undefined)) {
      throw new Error("Escalation has no canonical production task");
    }
    return this.board.readTask(runtime?.taskId ?? incident!.taskId);
  }
}
