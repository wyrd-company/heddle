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
  if (options.liveIssue)
    return requirementFindings(file, blueprint, options.liveIssue);
  const findings: ValidationFinding[] = [];
  if (blueprint.requires?.["issue"] !== undefined) {
    findings.push({
      file,
      node: "$blueprint",
      rule: "requires.issue.live",
      message:
        "not checked: configure a bound project for live requires.issue validation",
    });
  }
  for (const [nodeId, node] of Object.entries(blueprint.nodes)) {
    if (node.stage === true) {
      findings.push({
        file,
        node: nodeId,
        rule: "requires.issue.stage-name",
        message:
          "not checked: configure a bound project for live stage-name validation",
      });
    }
  }
  return findings;
}

export function requirementFindings(
  file: string,
  blueprint: Blueprint,
  projects: NonNullable<ValidationOptions["liveIssue"]>,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const required = blueprint.requires?.["issue"] as
    | {
        fields?: string[];
        type?: string[];
        labels?: string[];
        frontMatter?: string[];
      }
    | undefined;
  const report = (
    message: string,
    node = "$blueprint",
    rule = "requires.issue.live",
  ) => findings.push({ file, node, rule, message });
  if (!projects.length) report("No bound projects configured");
  for (const project of projects) {
    for (const [kind, values, actual] of [
      ["field", required?.fields, project.fields],
      ["type", required?.type, project.types],
      ["label", required?.labels, project.labels],
    ] as const) {
      for (const value of values ?? [])
        if (!actual.includes(value))
          report(`${project.name}: missing ${kind} ${value}`);
    }
    for (const issue of project.issues)
      for (const key of required?.frontMatter ?? [])
        if (!issue.frontMatter.includes(key))
          report(`${project.name}: ${issue.ref} missing frontMatter.${key}`);
    for (const [id, node] of Object.entries(blueprint.nodes))
      if (node.stage === true && !project.stages.includes(id))
        report(
          `${project.name}: Status has no stage option ${id}`,
          id,
          "requires.issue.stage-name",
        );
  }
  return findings;
}
