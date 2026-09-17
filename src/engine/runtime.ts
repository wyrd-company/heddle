// ---
// relationships:
//   implements: engine-and-run-model
//   references: flowcraft-stage-semantics
// ---
import {
  FlowRuntime,
  type ContextImplementation,
  type NodeResult,
  type WorkflowBlueprint,
} from "flowcraft";
import jsonata from "jsonata";
import type { Data } from "./types.js";

export class Attention extends Error {}

/** Flowcraft's synchronous evaluator cannot consume JSONata's async result. */
export class DurableRuntime extends FlowRuntime<Data, Data> {
  readonly pausing = new Set<string>();
  override async determineNextNodes(
    blueprint: WorkflowBlueprint,
    nodeId: string,
    result: NodeResult<unknown>,
    context: ContextImplementation<Data>,
    executionId?: string,
  ) {
    // Pausing is not a result. Route only when a caller resumes this node.
    const data = await context.toJSON();
    if (this.pausing.delete(nodeId)) return [];
    const edges = [];
    const outgoing = blueprint.edges.filter((edge) => edge.source === nodeId);
    for (const edge of outgoing) {
      if (
        !edge.condition ||
        (await jsonata(edge.condition).evaluate({ ...data, result }))
      ) {
        const matched = { ...edge };
        delete matched.condition;
        edges.push(matched);
      }
    }
    if (outgoing.length > 0 && edges.length === 0)
      throw new Attention(`No edge handles the result of ${nodeId}`);
    return super.determineNextNodes(
      { ...blueprint, edges },
      nodeId,
      result,
      context,
      executionId,
    );
  }
}

export async function resolveValues(
  value: unknown,
  context: Data,
): Promise<unknown> {
  if (Array.isArray(value))
    return Promise.all(value.map((item) => resolveValues(item, context)));
  if (value !== null && typeof value === "object") {
    const record = value as Data;
    if (typeof record["from"] === "string" && Object.keys(record).length === 1)
      return jsonata(record["from"]).evaluate(context) as Promise<unknown>;
    return Object.fromEntries(
      await Promise.all(
        Object.entries(record).map(async ([key, item]) => [
          key,
          await resolveValues(item, context),
        ]),
      ),
    );
  }
  return value;
}
