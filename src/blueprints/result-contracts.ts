// ---
// relationships:
//   implements: node-types
// ---
import jsonata from "jsonata";
import type { WorkflowBlueprint } from "flowcraft";
import { isObject, validateNodeParams } from "./schema-validation.js";

/** Shared by authoring validation and the programmatic engine boundary. */
export function resultContractFindings(blueprint: WorkflowBlueprint) {
  const findings: { node: string; message: string }[] = [];
  for (const node of blueprint.nodes) {
    const report = (message: string) =>
      findings.push({ node: node.id, message });
    if (node.uses !== "terminal-result" && node.uses !== "aggregate") continue;
    const checked = validateNodeParams(node.uses, node.params);
    if (!checked.valid) {
      report(`Invalid ${node.uses} parameters`);
      continue;
    }
    if (node.uses === "terminal-result") {
      if (blueprint.edges.some((edge) => edge.source === node.id))
        report("A terminal-result cannot have outgoing edges");
      for (const expression of contextExpressions(node.params?.["value"])) {
        try {
          jsonata(expression);
        } catch {
          report("Terminal value has an invalid JSONata reference");
        }
      }
      continue;
    }
    if (node.config?.joinStrategy === "any")
      report("Aggregate requires an all join");
    const predecessors = new Set(
      blueprint.edges
        .filter((edge) => edge.target === node.id)
        .map((edge) => edge.source),
    );
    const bindings = node.params?.["bindings"] as Record<
      string,
      { node: string; path?: string }
    >;
    const bound = new Set<string>();
    for (const [name, binding] of Object.entries(bindings)) {
      const source = binding.node;
      if (!predecessors.has(source))
        report(`Binding ${name} must name a direct predecessor: ${source}`);
      if (bound.has(source))
        report(`Predecessor is bound more than once: ${source}`);
      bound.add(source);
      if (typeof binding.path === "string") {
        try {
          jsonata(binding.path);
        } catch {
          report(`Binding ${name} has an invalid JSONata path`);
        }
      }
    }
    for (const source of predecessors)
      if (!bound.has(source))
        report(`Predecessor has no aggregate binding: ${source}`);
  }
  return findings;
}

function contextExpressions(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(contextExpressions);
  if (!isObject(value)) return [];
  if (typeof value["from"] === "string" && Object.keys(value).length === 1)
    return [value["from"]];
  return Object.values(value).flatMap(contextExpressions);
}
