// ---
// relationships:
//   implements: heddle
// ---

import { BlueprintValidationError } from "./errors.js";
import type { LifecycleEdge, LifecycleNode } from "./types.js";

/**
 * A `question` node asks a role one or more questions in the harness question
 * shape and waits; the answer becomes the node's output and its edges route on
 * it. Approval is one use; fetching outside information is another.
 */
export const questionNodeUse = "question" as const;

/** The one disposition a question node resumes with. */
export const answeredDisposition = "answered";

export const questionRoles = ["adjudicator", "operator"] as const;
export type QuestionRole = (typeof questionRoles)[number];

export type QuestionNodeQuestion = {
  header?: string;
  id: string;
  multiSelect?: boolean;
  options: { description?: string; label: string }[];
  question: string;
};

export type QuestionNodeParams = {
  questions: QuestionNodeQuestion[];
  role: QuestionRole;
};

const nonBlank = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** A node whose completion waits on something outside the graph. */
export const isAwaitingNode = (node: Pick<LifecycleNode, "uses">): boolean =>
  node.uses === "wait" || node.uses === questionNodeUse;

export const questionNodeParams = (node: LifecycleNode): QuestionNodeParams => {
  const params = record(node.params);
  const invalid = (reason: string): BlueprintValidationError =>
    new BlueprintValidationError(
      `Question node ${JSON.stringify(node.id)} ${reason}`,
    );
  if (params === undefined) throw invalid("has no params");
  const role = params["role"];
  if (!questionRoles.some((candidate) => candidate === role)) {
    throw invalid(
      `role must be one of ${questionRoles.map((r) => JSON.stringify(r)).join(", ")}`,
    );
  }
  const questions = params["questions"];
  if (!Array.isArray(questions) || questions.length === 0) {
    throw invalid("must ask at least one question");
  }
  const ids = new Set<string>();
  const parsed = questions.map((candidate, index): QuestionNodeQuestion => {
    const question = record(candidate);
    if (question === undefined)
      throw invalid(`question ${index} is not an object`);
    if (!nonBlank(question["id"])) throw invalid(`question ${index} has no id`);
    if (ids.has(question["id"])) {
      throw invalid(`repeats question id ${JSON.stringify(question["id"])}`);
    }
    ids.add(question["id"]);
    if (!nonBlank(question["question"])) {
      throw invalid(`question ${JSON.stringify(question["id"])} has no text`);
    }
    const options = question["options"];
    if (
      !Array.isArray(options) ||
      options.some((option) => !nonBlank(record(option)?.["label"]))
    ) {
      throw invalid(
        `question ${JSON.stringify(question["id"])} options must each carry a label`,
      );
    }
    if (question["header"] !== undefined && !nonBlank(question["header"])) {
      throw invalid(
        `question ${JSON.stringify(question["id"])} header is blank`,
      );
    }
    if (
      question["multiSelect"] !== undefined &&
      typeof question["multiSelect"] !== "boolean"
    ) {
      throw invalid(
        `question ${JSON.stringify(question["id"])} multiSelect must be a boolean`,
      );
    }
    return {
      ...(question["header"] === undefined
        ? {}
        : { header: question["header"] as string }),
      id: question["id"],
      ...(question["multiSelect"] === undefined
        ? {}
        : { multiSelect: question["multiSelect"] as boolean }),
      options: options.map((option) => {
        const value = record(option)!;
        return {
          ...(value["description"] === undefined
            ? {}
            : { description: String(value["description"]) }),
          label: value["label"] as string,
        };
      }),
      question: question["question"],
    };
  });
  return { questions: parsed, role: role as QuestionRole };
};

/**
 * A question node's edges route on the answer: every edge carries a condition,
 * or exactly one edge carries none and always fires. `disposition` belongs to
 * `advance`, so a question edge never declares one.
 */
export const validateQuestionEdges = (
  node: LifecycleNode,
  edges: readonly LifecycleEdge[],
): void => {
  if (edges.length === 0) {
    throw new BlueprintValidationError(
      `Question node ${JSON.stringify(node.id)} has no outgoing edges`,
    );
  }
  for (const edge of edges) {
    if (edge.disposition !== undefined) {
      throw new BlueprintValidationError(
        `Question node ${JSON.stringify(node.id)} edge to ${JSON.stringify(edge.target)} must route on a condition, not a disposition`,
      );
    }
  }
  const unconditional = edges.filter(
    ({ condition }) => condition === undefined,
  );
  if (unconditional.length > 1) {
    throw new BlueprintValidationError(
      `Question node ${JSON.stringify(node.id)} has more than one edge without a condition`,
    );
  }
};
