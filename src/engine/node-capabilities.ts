// ---
// relationships:
//   implements: engine-and-run-model
// ---
import type { EngineNode } from "./types.js";

const builtInNodeTypes = new Set([
  "aggregate",
  "child-run",
  "lifecycle-start",
  "sleep",
  "terminal-result",
  "wait",
]);

export function supportsNodeType(
  nodes: Readonly<Record<string, EngineNode>>,
  type: string,
): boolean {
  return builtInNodeTypes.has(type) || nodes[type] !== undefined;
}
