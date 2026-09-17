// ---
// relationships:
//   implements:
//     - blueprint-authoring
//     - node-types
// ---
import jsonata from "jsonata";

import type {
  Blueprint,
  JsonObject,
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

function requiredPassResults(params: JsonObject | undefined): string[] {
  const results = ["handoff", "overridden"];
  if (params?.["escalation"] === "ends-stage") results.push("escalate");
  if (params?.["deadline"] !== undefined) results.push("timeout");
  if (params?.["inactivity"] !== undefined) results.push("idle");
  if (params?.["turnEndPolicy"] === "allow") results.push("turnEnded");
  return results;
}

function handledResults(blueprint: Blueprint, nodeId: string): Set<string> {
  const outgoing = (blueprint.edges ?? []).filter(
    (edge) => edge.from === nodeId,
  );
  if (outgoing.some((edge) => edge.when === undefined)) {
    return new Set(requiredPassResults(blueprint.nodes[nodeId]?.params));
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
    if (node.uses === "subflow") {
      findings.push(
        finding(file, nodeId, "heddle.no-subflow", "subflow is not supported"),
      );
    }
    if (node.uses === "pass") {
      const handled = handledResults(blueprint, nodeId);
      for (const result of requiredPassResults(node.params)) {
        if (!handled.has(result)) {
          findings.push(
            finding(
              file,
              nodeId,
              "heddle.pass-result",
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
