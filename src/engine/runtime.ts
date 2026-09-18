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
import { blueprintContext } from "../blueprints/flowcraft.js";
import type { Data } from "./types.js";

export class Attention extends Error {}
export class DispatchHeld extends Error {}
export function isDispatchHeld(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error instanceof DispatchHeld || isDispatchHeld(error.cause))
  );
}

/** Flowcraft's synchronous evaluator cannot consume JSONata's async result. */
export class DurableRuntime extends FlowRuntime<Data, Data> {
  readonly pausing = new Set<string>();
  pending: string[] = [];
  resumedNodeId?: string;
  override async determineNextNodes(
    blueprint: WorkflowBlueprint,
    nodeId: string,
    result: NodeResult<unknown>,
    context: ContextImplementation<Data>,
    executionId?: string,
  ) {
    const data = {
      ...(await context.toJSON()),
      blueprint: blueprintContext(blueprint),
    };
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
    if (nodeId === this.resumedNodeId && edges.length > 1)
      throw new Attention(`Multiple edges handle the result of ${nodeId}`);
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
