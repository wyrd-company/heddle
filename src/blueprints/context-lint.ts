// ---
// relationships:
//   implements: blueprint-authoring
// ---
import type { Blueprint, ValidationFinding } from "./types.js";

function finding(
  file: string,
  node: string,
  rule: string,
  message: string,
): ValidationFinding {
  return { file, node, rule, message };
}

function references(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(references);
  if (typeof value !== "object" || value === null) return [];
  const object = value as Record<string, unknown>;
  const own = typeof object["from"] === "string" ? [object["from"]] : [];
  return [
    ...own,
    ...Object.entries(object)
      .filter(([key]) => key !== "from")
      .flatMap(([, nested]) => references(nested)),
  ];
}

function templateKeys(value: unknown): string[] {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>)["inline"] !== "string"
  )
    return [];
  const inline = (value as Record<string, unknown>)["inline"] as string;
  return [...inline.matchAll(/\{\{\s*([A-Za-z][\w-]*)\s*\}\}/gu)].flatMap(
    (match) => (match[1] === undefined ? [] : [match[1]]),
  );
}

export function contextKeyFindings(
  file: string,
  blueprint: Blueprint,
): ValidationFinding[] {
  const initial = [
    "issue",
    "blueprint",
    "stages",
    ...Object.keys(blueprint.inputs ?? {}),
  ];
  const incoming = new Map<string, string[]>();
  for (const edge of blueprint.edges ?? []) {
    const sources = incoming.get(edge.to) ?? [];
    sources.push(edge.from);
    incoming.set(edge.to, sources);
  }
  const findings: ValidationFinding[] = [];
  for (const [nodeId, node] of Object.entries(blueprint.nodes)) {
    const available = new Set([...initial, nodeId]);
    const pending = [...(incoming.get(nodeId) ?? [])];
    while (pending.length > 0) {
      const predecessor = pending.pop();
      if (predecessor === undefined || available.has(predecessor)) continue;
      available.add(predecessor);
      pending.push(...(incoming.get(predecessor) ?? []));
    }
    for (const expression of references(node.params)) {
      const root = /^([A-Za-z][\w-]*)(?:\.|$)/u.exec(expression)?.[1];
      if (root !== undefined && !available.has(root))
        findings.push(
          finding(
            file,
            nodeId,
            "heddle.context-key",
            `Context key cannot be provided: ${root}`,
          ),
        );
    }
    if (
      node.uses === "on-issue-change" &&
      node.params?.["bindings"] !== null &&
      typeof node.params?.["bindings"] === "object" &&
      !Array.isArray(node.params["bindings"])
    ) {
      for (const [name, path] of Object.entries(node.params["bindings"])) {
        if (typeof path !== "string") continue;
        const root = /^([A-Za-z][\w-]*)(?:\.|$)/u.exec(path)?.[1];
        if (root !== undefined && !available.has(root))
          findings.push(
            finding(
              file,
              nodeId,
              "heddle.context-key",
              `Bound value ${name} cannot be provided: ${root}`,
            ),
          );
      }
      const bindings = new Set(Object.keys(node.params["bindings"]));
      const condition = node.params["when"];
      if (typeof condition === "string")
        for (const match of condition.matchAll(
          /\$([A-Za-z][\w-]*)\b(?!\s*\()/gu,
        )) {
          const name = match[1];
          if (name !== undefined && !bindings.has(name))
            findings.push(
              finding(
                file,
                nodeId,
                "heddle.issue-change-binding",
                `Issue-change variable has no immutable binding: ${name}`,
              ),
            );
        }
    }
    if (node.uses === "notify")
      for (const key of [
        ...templateKeys(node.params?.["title"]),
        ...templateKeys(node.params?.["message"]),
      ])
        if (!available.has(key))
          findings.push(
            finding(
              file,
              nodeId,
              "heddle.context-key",
              `Template context key cannot be provided: ${key}`,
            ),
          );
  }
  return findings;
}
