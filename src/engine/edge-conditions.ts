// ---
// relationships:
//   implements: heddle
// ---

import jsonata from "jsonata";

import { BlueprintValidationError } from "./errors.js";
import { recordNodeFinish } from "./lifecycle-projection.js";
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

export const defaultDispositionCondition = (disposition: string): string =>
  `result.output.dispositions.${disposition}`;

/** The condition an edge routes on: its own, or the disposition default. */
export const effectiveCondition = (edge: LifecycleEdge): string | undefined =>
  edge.condition ??
  (edge.disposition === undefined
    ? undefined
    : defaultDispositionCondition(edge.disposition));

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
    const expression = effectiveCondition(edge);
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
): Promise<EdgeRouting> => {
  const routing: EdgeRouting = {};
  for (const [index, edge] of blueprint.edges.entries()) {
    if (edge.source !== sourceNodeId) continue;
    const expression = effectiveCondition(edge);
    if (expression === undefined) continue;
    routing[edgeRoutingSlot(index)] = await evaluate(edge, expression, data);
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
    effectiveCondition(edge) === undefined
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
 * chosen disposition selects exactly one edge.
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
  const routing = await evaluateOutgoingConditions(blueprint, waitNodeId, {
    ...context,
    result: { output },
  });
  const matched = blueprint.edges.flatMap((edge, index) =>
    edge.source === waitNodeId &&
    edge.disposition === disposition &&
    routing[edgeRoutingSlot(index)] === true
      ? [edgeLabel(edge)]
      : [],
  );
  if (matched.length !== 1) {
    throw new EdgeRoutingError(waitNodeId, disposition, matched);
  }
  return JSON.stringify(mergeRouting(context, routing));
};
