// ---
// relationships:
//   implements: heddle
// ---

import nunjucks from "nunjucks";

import type { BoardTask } from "../board-adapter/index.js";
import {
  answeredDisposition,
  lifecycleProjectionOf,
  questionNodeParams,
  readLifecycleContext,
  type LifecycleNode,
  type LifecycleProjection,
} from "../engine/index.js";
import type {
  AnsweredEscalation,
  EscalationCoordinator,
  EscalationInput,
  EscalationQuestion,
  PendingEscalation,
} from "../mcp-server/index.js";
import type { JsonValue, SqlitePersistence } from "../persistence/index.js";

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

const sortedJson = (value: JsonValue): JsonValue => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortedJson);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedJson(value[key]!)]),
  );
};

const textEnvironment = (): nunjucks.Environment => {
  const environment = new nunjucks.Environment(undefined, {
    autoescape: false,
    throwOnUndefined: true,
  });
  environment.addFilter("stableJson", (value: JsonValue) =>
    JSON.stringify(sortedJson(value), undefined, 2),
  );
  return environment;
};

/**
 * Question text is a template over what the graph has done so far, so the
 * role sees the proposal it is deciding on, not a reference to it.
 */
export const renderQuestionText = (
  text: string,
  context: { lifecycle: LifecycleProjection; task: JsonValue },
): string => {
  try {
    return new nunjucks.Template(text, textEnvironment(), "question").render(
      context,
    );
  } catch (error) {
    throw new Error(
      `Question text ${JSON.stringify(text)} failed to render: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

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

export class LifecycleQuestionCoordinator {
  constructor(
    private readonly persistence: SqlitePersistence,
    private readonly escalation: () => Pick<EscalationCoordinator, "escalate">,
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
    const escalationId = questionOperationId(input.node.id, visit);
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
