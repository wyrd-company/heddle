// ---
// relationships:
//   implements: command-line-interface
// ---
import type { EngineNode } from "../engine/types.js";

/** The node types a running service composes onto the engine's own. */
export function serviceNodes(
  policy: EngineNode,
  pass: EngineNode,
): Record<string, EngineNode> {
  return { policy, pass };
}
