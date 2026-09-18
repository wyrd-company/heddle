// ---
// relationships:
//   implements: engine-and-run-model
// ---
import type { EngineNode } from "./types.js";

/** The node types the engine dispatches without a registered implementation. */
export const BUILT_IN_NODE_TYPES: readonly string[] = [
  "aggregate",
  "child-run",
  "lifecycle-start",
  "sleep",
  "terminal-result",
  "wait",
];
const builtInNodeTypes = new Set(BUILT_IN_NODE_TYPES);

export function supportsNodeType(
  nodes: Readonly<Record<string, EngineNode>>,
  type: string,
): boolean {
  return builtInNodeTypes.has(type) || nodes[type] !== undefined;
}
