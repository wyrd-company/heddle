// ---
// relationships:
//   implements: heddle
// ---

import type { BoardTask } from "../board-adapter/index.js";
import {
  answeredDisposition,
  lifecycleProjectionOf,
  questionNodeParams,
  readLifecycleContext,
  type LifecycleNode,
} from "../engine/index.js";
import type {
  AnsweredEscalation,
  EscalationCoordinator,
  EscalationInput,
  EscalationQuestion,
  PendingEscalation,
} from "../mcp-server/index.js";
import type { JsonValue, SqlitePersistence } from "../persistence/index.js";
import type { ReconcilerAttentionQueue } from "../reconciler/index.js";

import { createProductionErrorAttention } from "./error-visibility.js";
import {
  renderLifecycleText,
  type LifecycleTextContext,
} from "./lifecycle-text.js";

/**
 * The stable owner key of a question node occurrence. Heddle writes it, so a
 * blueprint author cannot present a session as a lifecycle question.
 */
export const questionOwnerSessionKey = (
  nodeId: string,
  visit: number,
): string => `question:${nodeId}:${visit}`;

/** The resume operation an answered occurrence completes, once. */
export const questionOperationId = (nodeId: string, visit: number): string =>
  `question:${nodeId}:${visit}`;

/** Question text is a template over what the graph has done so far. */
export const renderQuestionText = (
  text: string,
  context: LifecycleTextContext,
): string => renderLifecycleText(text, context, "question text");

/**
 * What a question node hands the graph: the answer contract verbatim, a
 * per-option projection so the common guard is a path, and who answered.
 */
export const questionAnswerOutput = (
  opened: PendingEscalation,
  answered: AnsweredEscalation,
): Record<string, JsonValue> => ({
  answeredBy: answered.answeredBy as unknown as JsonValue,
  answers: answered.answers as unknown as JsonValue,
  ...(answered.prose === undefined ? {} : { prose: answered.prose }),
  selected: Object.fromEntries(
    opened.questions.map((question) => [
      question.id,
      Object.fromEntries(
        (answered.answers[question.id]?.selectedOptions ?? []).map((label) => [
          label,
          true,
        ]),
      ),
    ]),
  ),
});

/** Raised once per occurrence when a blueprint asks a role the deployment cannot supply. */
export const questionRoleUnavailableCode =
  "lifecycle-question-role-unavailable";

export class LifecycleQuestionCoordinator {
  constructor(
    private readonly persistence: SqlitePersistence,
    private readonly escalation: () => Pick<EscalationCoordinator, "escalate">,
    private readonly deployment: {
      /** Whether adjudication is composed for `adjudicator` questions. */
      adjudication: boolean;
      attention: Pick<ReconcilerAttentionQueue, "has" | "raise">;
    },
  ) {}

  /**
   * Asks the node's role for the current occurrence. Idempotent: the
   * escalation history keys the occurrence, so a repeated pass re-routes the
   * same question instead of opening another.
   */
  async ask(input: {
    instanceId: string;
    node: LifecycleNode;
    task: BoardTask;
  }): Promise<{ escalationId: string; visit: number }> {
    const record = this.persistence.getInstance(input.instanceId);
    if (record === undefined) {
      throw new Error(`Instance does not exist: ${input.instanceId}`);
    }
    const projection = lifecycleProjectionOf(readLifecycleContext(record));
    const visit = (projection.visits[input.node.id] ?? 0) + 1;
    const params = questionNodeParams(input.node);
    const escalationId = questionOperationId(input.node.id, visit);
    if (params.role === "adjudicator" && !this.deployment.adjudication) {
      // The blueprint names a role this deployment does not supply. Nothing
      // answers under a substituted authority: the lifecycle holds at the
      // node and the operator is told why, once per occurrence.
      const attentionId = `lifecycle:question-role:${input.instanceId}:${input.node.id}:${visit}`;
      if (!(await this.deployment.attention.has(attentionId))) {
        const message = `Question node ${JSON.stringify(input.node.id)} asks the adjudicator, and this deployment composes no adjudication. Configure adjudication and restart, or change the blueprint.`;
        await this.deployment.attention.raise(
          createProductionErrorAttention({
            attentionId,
            code: questionRoleUnavailableCode,
            error: new Error(message),
            instanceId: input.instanceId,
            message,
            taskId: input.task.id,
          }),
        );
      }
      return { escalationId, visit };
    }
    const context = {
      lifecycle: projection,
      task: (projection.task ?? input.task) as JsonValue,
    };
    const questions: EscalationQuestion[] = params.questions.map(
      (question) => ({
        ...(question.header === undefined
          ? {}
          : { header: renderQuestionText(question.header, context) }),
        id: question.id,
        multiSelect: question.multiSelect ?? false,
        options: question.options.map((option) => ({
          ...(option.description === undefined
            ? {}
            : { description: renderQuestionText(option.description, context) }),
          label: option.label,
        })),
        question: renderQuestionText(question.question, context),
      }),
    );
    const escalation: EscalationInput = {
      escalationId,
      questions,
      requestId: `${input.instanceId}:${escalationId}`,
      threadId: `lifecycle:${input.instanceId}`,
    };
    await this.escalation().escalate(
      {
        instance: record,
        sessionKey: questionOwnerSessionKey(input.node.id, visit),
        stage: { id: input.node.id, skills: [], tools: [] },
      },
      escalation,
      {
        answeringAuthority:
          params.role === "adjudicator" ? "adjudication" : "operator",
        question: { nodeId: input.node.id, visit },
      },
    );
    return { escalationId, visit };
  }
}

export { answeredDisposition };
