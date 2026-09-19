// ---
// relationships:
//   implements:
//     - blueprint-authoring
//     - node-types
// ---
import type { Blueprint, ValidationFinding } from "./types.js";

/**
 * An intake blueprint exists to give an issue an owner. Every path through it
 * ends at a `lifecycle-start`, so an issue can never be left with no run.
 */
export function intakeTerminalFindings(
  file: string,
  blueprint: Blueprint,
): ValidationFinding[] {
  const entries = Object.entries(blueprint.nodes);
  if (!entries.some(([, node]) => node.uses === "lifecycle-start")) return [];
  const sources = new Set((blueprint.edges ?? []).map((edge) => edge.from));
  return entries.flatMap(([nodeId, node]) =>
    sources.has(nodeId) || node.uses === "lifecycle-start"
      ? []
      : [
          {
            file,
            node: nodeId,
            rule: "heddle.intake-terminal",
            message: `Node ${nodeId} uses ${node.uses} and has no outgoing edge, so this intake can end without starting a lifecycle and leave the issue unowned`,
          },
        ],
  );
}
