// ---
// relationships:
//   implements:
//     - blueprint-authoring
//     - node-types
// ---
import jsonata from "jsonata";

import { contextKeyFindings } from "./context-lint.js";
import { isNodeTypeName, NODE_TYPE_REGISTRY } from "./node-types.js";
import type {
  Blueprint,
  BlueprintNode,
  ValidationFinding,
  ValidationOptions,
} from "./types.js";

const builtInQuestionRoles = new Set(["operator", "adjudicator"]);

function finding(
  file: string,
  node: string,
  rule: string,
  message: string,
): ValidationFinding {
  return { file, node, rule, message };
}

function requiredResults(node: BlueprintNode): string[] {
  if (!isNodeTypeName(node.uses)) return [];
  const results = [...NODE_TYPE_REGISTRY[node.uses].results];
  if (node.uses === "pass") {
    if (node.params?.["escalation"] !== "ends-stage")
      remove(results, "escalate");
    if (node.params?.["deadline"] === undefined) remove(results, "timeout");
    if (node.params?.["inactivity"] === undefined) remove(results, "idle");
  }
  if (
    ["question", "on-issue-change"].includes(node.uses) &&
    node.params?.["deadline"] === undefined
  ) {
    remove(results, "timeout");
  }
  return results;
}

function remove(values: string[], value: string): void {
  const index = values.indexOf(value);
  if (index >= 0) values.splice(index, 1);
}

function handledResults(
  blueprint: Blueprint,
  nodeId: string,
  required: readonly string[],
): Set<string> {
  const outgoing = (blueprint.edges ?? []).filter(
    (edge) => edge.from === nodeId,
  );
  if (outgoing.some((edge) => edge.when === undefined)) {
    return new Set(required);
  }
  const handled = new Set<string>();
  for (const edge of outgoing) {
    for (const match of edge.when?.matchAll(
      /result\.output\.([A-Za-z][\w]*)/gu,
    ) ?? []) {
      if (match[1] !== undefined) handled.add(match[1]);
    }
  }
  return handled;
}

export function lintHeddle(
  file: string,
  blueprint: Blueprint,
  options: ValidationOptions,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const roles = options.configuredQuestionRoles ?? builtInQuestionRoles;
  const incoming = new Set((blueprint.edges ?? []).map((edge) => edge.to));
  const hasNaturalEntry = Object.keys(blueprint.nodes).some(
    (nodeId) => !incoming.has(nodeId),
  );
  if (
    blueprint.entry !== undefined &&
    blueprint.nodes[blueprint.entry] === undefined
  ) {
    findings.push(
      finding(
        file,
        "$blueprint",
        "heddle.entry",
        `Entry does not name an authored node: ${blueprint.entry}`,
      ),
    );
  } else if (hasNaturalEntry && blueprint.entry !== undefined) {
    findings.push(
      finding(
        file,
        "$blueprint",
        "heddle.entry",
        "Entry is only valid for a graph with no natural start",
      ),
    );
  } else if (!hasNaturalEntry && blueprint.entry === undefined) {
    findings.push(
      finding(
        file,
        "$blueprint",
        "heddle.entry",
        "A graph with no natural entry node must declare entry",
      ),
    );
  }
  for (const [nodeId, node] of Object.entries(blueprint.nodes)) {
    if (
      node.uses === "github" &&
      node.params?.["operation"] === "set-field" &&
      ["Status", "Paused"].includes(String(node.params["field"]))
    ) {
      findings.push(
        finding(
          file,
          nodeId,
          "heddle.owned-field",
          "Status and Paused are owned by the service",
        ),
      );
    }
    if (node.uses === "subflow") {
      findings.push(
        finding(file, nodeId, "heddle.no-subflow", "subflow is not supported"),
      );
    }
    if (isNodeTypeName(node.uses) && NODE_TYPE_REGISTRY[node.uses].pausing) {
      const required = requiredResults(node);
      const handled = handledResults(blueprint, nodeId, required);
      for (const result of required) {
        if (!handled.has(result)) {
          findings.push(
            finding(
              file,
              nodeId,
              "heddle.unhandled-result",
              `Result is not handled: ${result}`,
            ),
          );
        }
      }
    }
    if (node.uses === "question") {
      const role = node.params?.["role"];
      if (typeof role === "string" && !roles.has(role)) {
        findings.push(
          finding(
            file,
            nodeId,
            "heddle.question-role",
            `No channel serves role: ${role}`,
          ),
        );
      }
    }
  }
  for (const edge of blueprint.edges ?? []) {
    if (Object.hasOwn(edge, "action")) {
      findings.push(
        finding(
          file,
          edge.from,
          "heddle.no-action-edge",
          "Edge actions are not supported",
        ),
      );
    }
  }
  findings.push(...contextKeyFindings(file, blueprint));
  return findings;
}

export function validateExpressions(
  file: string,
  blueprint: Blueprint,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const expressions: { node: string; value: unknown }[] = (
    blueprint.edges ?? []
  ).map((edge) => ({ node: edge.from, value: edge.when }));
  for (const [nodeId, node] of Object.entries(blueprint.nodes)) {
    if (node.uses === "on-issue-change") {
      expressions.push({ node: nodeId, value: node.params?.["when"] });
    }
  }
  for (const expression of expressions) {
    if (typeof expression.value !== "string") continue;
    try {
      jsonata(expression.value);
    } catch (error) {
      findings.push(
        finding(
          file,
          expression.node,
          "expression.jsonata",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
  return findings;
}
