// ---
// relationships:
//   implements:
//     - blueprint-authoring
//     - node-types
// ---
import type {
  Blueprint,
  ValidationFinding,
  ValidationOptions,
} from "./types.js";

export function validateLiveRequirements(
  file: string,
  blueprint: Blueprint,
  options: ValidationOptions,
): ValidationFinding[] {
  if (options.checkRequiresIssue !== true) return [];
  const findings: ValidationFinding[] = [];
  if (blueprint.requires?.["issue"] !== undefined) {
    findings.push({
      file,
      node: "$blueprint",
      rule: "requires.issue.live",
      message: "not checked: live requires.issue validation is not implemented",
    });
  }
  for (const [nodeId, node] of Object.entries(blueprint.nodes)) {
    if (node.stage === true) {
      findings.push({
        file,
        node: nodeId,
        rule: "requires.issue.stage-name",
        message:
          "not checked: live stage-name single-select validation is not implemented",
      });
    }
  }
  return findings;
}
