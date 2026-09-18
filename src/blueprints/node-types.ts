// ---
// relationships:
//   implements: node-types
// ---
import contracts from "./node-types.json" with { type: "json" };
import type { JsonObject } from "./types.js";

export interface NodeTypeContract {
  readonly description: string;
  /** Whether Heddle has a run-time implementation for this node type. */
  readonly available: boolean;
  /** Per-operation availability, for a node type that takes an operation. */
  readonly operations?: Readonly<Record<string, boolean>>;
  readonly paramsSchema: JsonObject;
  readonly outputSchema: JsonObject;
  readonly contextWrites: readonly string[];
  readonly pausing: boolean;
  readonly results: readonly string[];
}

export const NODE_TYPE_REGISTRY = contracts satisfies Record<
  string,
  NodeTypeContract
>;

export type NodeTypeName = keyof typeof NODE_TYPE_REGISTRY;

export const isNodeTypeName = (value: string): value is NodeTypeName =>
  Object.hasOwn(NODE_TYPE_REGISTRY, value);
