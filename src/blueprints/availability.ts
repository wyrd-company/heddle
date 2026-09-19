// ---
// relationships:
//   implements:
//     - blueprint-authoring
//     - node-types
// ---
import {
  isNodeTypeName,
  NODE_TYPE_REGISTRY,
  type NodeTypeContract,
} from "./node-types.js";
import type { Blueprint, ValidationFinding } from "./types.js";

export const UNAVAILABLE_NODE_TYPE_RULE = "heddle.unavailable-node-type";
export const UNAVAILABLE_OPERATION_RULE = "heddle.unavailable-operation";

/**
 * The catalog publishes every designed node type and operation. Availability
 * marks the ones Heddle can run today, so an author learns at validation time
 * that a blueprint has nothing behind it.
 */
export function availabilityFindings(
  file: string,
  blueprint: Blueprint,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  for (const [node, definition] of Object.entries(blueprint.nodes)) {
    if (!isNodeTypeName(definition.uses)) continue;
    const contract: NodeTypeContract = NODE_TYPE_REGISTRY[definition.uses];
    if (!contract.available) {
      findings.push({
        file,
        node,
        rule: UNAVAILABLE_NODE_TYPE_RULE,
        message: `Node type is not available yet, because Heddle has no run-time implementation for it: ${definition.uses}`,
      });
      continue;
    }
    const operation = definition.params?.["operation"];
    if (typeof operation !== "string") continue;
    if (contract.operations?.[operation] === false) {
      findings.push({
        file,
        node,
        rule: UNAVAILABLE_OPERATION_RULE,
        message: `${definition.uses} operation is not available yet, because Heddle has no run-time implementation for it: ${operation}`,
      });
    }
  }
  return findings;
}
