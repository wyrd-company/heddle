// ---
// relationships:
//   implements: heddle
// ---

import jsonata from "jsonata";

import { BlueprintValidationError } from "./errors.js";
import { recordNodeFinish } from "./lifecycle-projection.js";
import { questionNodeUse } from "./question-node.js";
import type { LifecycleBlueprint, LifecycleEdge } from "./types.js";

/**
 * Context key under which Heddle stores the evaluated outgoing-edge conditions
 * of the node that just finished. Flowcraft's default evaluator reads a plain
 * property path, so each conditional edge in the runtime blueprint is rewritten
 * to `heddleEdges.e<index>` and Heddle evaluates the authored JSONata
 * expression itself before Flowcraft routes.
 */
export const edgeRoutingKey = "heddleEdges";

export const edgeRoutingSlot = (edgeIndex: number): string => `e${edgeIndex}`;

export const edgeLabel = (edge: LifecycleEdge): string =>
  edge.disposition === undefined
    ? `${edge.source}->${edge.target}`
    : `${edge.source}->${edge.target} (${edge.disposition})`;

/**
 * The guard a disposition edge gets when it declares none. The name is a
 * JSON-encoded string literal, so any disposition, hyphenated, spaced, or
 * spelled like a JSONata keyword, is looked up rather than parsed as a path.
 */
export const defaultDispositionCondition = (disposition: string): string =>
  `$lookup(result.output.dispositions, ${JSON.stringify(disposition)})`;

const sourceUses = (
  blueprint: LifecycleBlueprint,
  edge: LifecycleEdge,
): string | undefined =>
  blueprint.nodes.find(({ id }) => id === edge.source)?.uses;

/**
 * The condition an edge routes on: its own; the disposition default for an
 * `advance` edge, narrowed to the else branch when sibling edges of the same
 * disposition carry conditions; `true` for the one unconditional edge of a
 * question node.
 */
export const effectiveCondition = (
  blueprint: LifecycleBlueprint,
  edge: LifecycleEdge,
): string | undefined => {
  if (edge.condition !== undefined) return edge.condition;
  if (edge.disposition !== undefined) {
    const gate = defaultDispositionCondition(edge.disposition);
    const conditionedSiblings = blueprint.edges.flatMap((sibling) =>
      sibling !== edge &&
      sibling.source === edge.source &&
      sibling.disposition === edge.disposition &&
      sibling.condition !== undefined
        ? [`(${sibling.condition})`]
        : [],
    );
    return conditionedSiblings.length === 0
      ? gate
      : `${gate} and $not(${conditionedSiblings.join(" or ")})`;
  }
  return sourceUses(blueprint, edge) === questionNodeUse ? "true" : undefined;
};

// JSONata throws plain objects `{ code, message, position, token }`, not
// Error instances, so the message is read off whatever shape arrives.
const causeMessage = (cause: unknown): string =>
  typeof cause === "object" &&
  cause !== null &&
  "message" in cause &&
  typeof cause.message === "string"
    ? cause.message
    : String(cause);

export class EdgeConditionError extends Error {
  constructor(
    public readonly edge: string,
    public readonly expression: string,
    cause: unknown,
  ) {
    super(
      `Edge ${edge} condition ${JSON.stringify(expression)} failed to evaluate: ${causeMessage(cause)}`,
      { cause },
    );
    this.name = "EdgeConditionError";
  }
}

export class EdgeRoutingError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly disposition: string,
    public readonly matchedEdges: string[],
  ) {
    super(
      matchedEdges.length === 0
        ? `Disposition ${JSON.stringify(disposition)} from node ${JSON.stringify(nodeId)} matched no edge condition`
        : `Disposition ${JSON.stringify(disposition)} from node ${JSON.stringify(nodeId)} matched more than one edge: ${matchedEdges.join(", ")}`,
    );
    this.name = "EdgeRoutingError";
  }
}

export const compileCondition = (
  expression: string,
  label: string,
): jsonata.Expression => {
  try {
    return jsonata(expression);
  } catch (error) {
    throw new BlueprintValidationError(
      `Edge ${label} condition ${JSON.stringify(expression)} does not compile: ${causeMessage(error)}`,
    );
  }
};

/** Validates every authored condition in the blueprint compiles. */
export const assertConditionsCompile = (
  blueprint: LifecycleBlueprint,
): void => {
  for (const edge of blueprint.edges) {
    const expression = effectiveCondition(blueprint, edge);
    if (expression !== undefined) compileCondition(expression, edgeLabel(edge));
  }
};

const evaluate = async (
  edge: LifecycleEdge,
  expression: string,
  data: Record<string, unknown>,
): Promise<boolean> => {
  const label = edgeLabel(edge);
  try {
    const value: unknown = await compileCondition(expression, label).evaluate(
      data,
    );
    return value === true;
  } catch (error) {
    throw new EdgeConditionError(label, expression, error);
  }
};

export type EdgeRouting = Record<string, boolean>;

/**
 * Evaluates the conditions of every conditional edge leaving `sourceNodeId`
 * against `data` (the workflow context plus `result`), keyed by routing slot.
 */
export const evaluateOutgoingConditions = async (
  blueprint: LifecycleBlueprint,
  sourceNodeId: string,
  data: Record<string, unknown>,
  candidate: (edge: LifecycleEdge) => boolean = () => true,
): Promise<EdgeRouting> => {
  const routing: EdgeRouting = {};
  for (const [index, edge] of blueprint.edges.entries()) {
    if (edge.source !== sourceNodeId) continue;
    const expression = effectiveCondition(blueprint, edge);
    if (expression === undefined) continue;
    // An edge that is not a candidate is never evaluated: its author condition
    // may be true, or may throw, without bearing on the chosen route.
    routing[edgeRoutingSlot(index)] = candidate(edge)
      ? await evaluate(edge, expression, data)
      : false;
  }
  return routing;
};

/**
 * Rewrites every conditional edge so Flowcraft's property evaluator reads the
 * boolean Heddle computed, and gives disposition edges without a condition
 * their default.
 */
export const routedBlueprint = (
  blueprint: LifecycleBlueprint,
): LifecycleBlueprint => ({
  ...blueprint,
  edges: blueprint.edges.map((edge, index) =>
    effectiveCondition(blueprint, edge) === undefined
      ? { ...edge }
      : { ...edge, condition: `${edgeRoutingKey}.${edgeRoutingSlot(index)}` },
  ),
});

export const mergeRouting = (
  context: Record<string, unknown>,
  routing: EdgeRouting,
): Record<string, unknown> => {
  const existing = context[edgeRoutingKey];
  return {
    ...context,
    [edgeRoutingKey]: {
      ...(typeof existing === "object" && existing !== null ? existing : {}),
      ...routing,
    },
  };
};

/**
 * Pre-evaluates the outgoing conditions of a resumed wait node and proves the
 * chosen disposition selects exactly one edge. Edges of other dispositions are
 * written false without evaluation.
 */
export const routeResume = async (
  blueprint: LifecycleBlueprint,
  serializedContext: string,
  waitNodeId: string,
  disposition: string,
  output: Record<string, unknown>,
): Promise<string> => {
  const context = recordNodeFinish(
    JSON.parse(serializedContext) as Record<string, unknown>,
    waitNodeId,
    output,
  );
  const question =
    blueprint.nodes.find(({ id }) => id === waitNodeId)?.uses ===
    questionNodeUse;
  // A wait node routes on the chosen disposition alone; a question node has
  // no disposition of its own and routes on the answer across every edge.
  const routing = await evaluateOutgoingConditions(
    blueprint,
    waitNodeId,
    { ...context, result: { output } },
    (edge) => question || edge.disposition === disposition,
  );
  const matched = blueprint.edges.flatMap((edge, index) =>
    edge.source === waitNodeId && routing[edgeRoutingSlot(index)] === true
      ? [edgeLabel(edge)]
      : [],
  );
  if (matched.length !== 1) {
    throw new EdgeRoutingError(waitNodeId, disposition, matched);
  }
  return JSON.stringify(mergeRouting(context, routing));
};
