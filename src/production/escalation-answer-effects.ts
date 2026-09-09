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
import { steerStageSession } from "../control-plane/index.js";
import type { ProductionT3Client } from "./composition.js";
import type { ProductionInstanceController } from "./instance-controller.js";
import { productionSessionBindingFor } from "./subagent-composition.js";
import { providerContextFromBinding } from "./session-binding.js";

const answerLines = (
  opened: PendingEscalation,
  answered: AnsweredEscalation,
): string[] =>
  opened.questions.flatMap((question) => {
    const answer = answered.answers[question.id]!;
    const selected =
      question.kind === "value"
        ? answer
        : `${question.options.find(({ id }) => id === answer)!.label} (${answer})`;
    return [`- Question: ${question.prompt}`, `  Answer: ${selected}`];
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
    private readonly instances: ProductionInstanceController,
    private readonly t3: ProductionT3Client,
  ) {}

  async record(input: {
    answered: AnsweredEscalation;
    opened: PendingEscalation;
  }): Promise<void> {
    const task = await this.#taskFor(input.opened.instanceId);
    if (task.parent === undefined) {
      throw new Error("Answered escalation task has no epic record");
    }
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
    await this.board.appendTaskActivity(
      task.parent,
      `${operation}:epic:${task.parent}`,
      activity,
    );
  }

  async deliver(input: {
    answered: AnsweredEscalation;
    commandId: string;
    message: string;
    messageId: string;
    opened: PendingEscalation;
  }): Promise<void> {
    const existing = productionSessionBindingFor(
      this.persistence,
      input.opened.ownerSessionKey,
    );
    const shell = await this.t3.getShell();
    const binding = shell.threads.some(({ id }) => id === existing.threadId)
      ? existing
      : await this.instances.reactivateStageForEscalation({
          instanceId: input.opened.instanceId,
          stageId: input.opened.stage,
          task: await this.#taskFor(input.opened.instanceId),
        });
    await steerStageSession(
      {
        commandId: input.commandId,
        interactionMode: binding.interactionMode,
        message: input.message,
        messageId: input.messageId,
        providerContext: providerContextFromBinding(binding),
        runtimeMode: binding.runtimeMode,
        threadId: binding.threadId,
      },
      { t3: this.t3 },
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
