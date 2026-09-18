// ---
// relationships:
//   implements: blueprint-authoring
// ---
import jsonata from "jsonata";

import type { Blueprint, JsonObject, ValidationFinding } from "./types.js";

/** One expression written where a blueprint routes, binds, or maps a value. */
export interface ExpressionSite {
  readonly node: string;
  readonly where: string;
  readonly expression: string;
}

const slug = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u;

/** The parts of a JSONata syntax tree this rule reads. */
interface AstNode {
  readonly type?: unknown;
  readonly value?: unknown;
  readonly lhs?: unknown;
  readonly rhs?: unknown;
  readonly steps?: unknown;
  readonly group?: unknown;
  readonly stages?: unknown;
  readonly predicate?: unknown;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNode(value: unknown): AstNode | undefined {
  return isObject(value) ? value : undefined;
}

function isMinus(node: AstNode | undefined): boolean {
  return node?.type === "binary" && node.value === "-";
}

/** A plain dotted path of bare names, with nothing the join could reorder. */
function plainSteps(value: unknown): string[] | undefined {
  const node = asNode(value);
  if (node === undefined) return undefined;
  if (node.type !== "path" || node.group !== undefined) return undefined;
  const steps = node.steps;
  if (!Array.isArray(steps) || steps.length === 0) return undefined;
  const names: string[] = [];
  for (const step of steps) {
    const item = asNode(step);
    if (
      item?.type !== "name" ||
      typeof item.value !== "string" ||
      item.stages !== undefined ||
      item.predicate !== undefined
    )
      return undefined;
    names.push(item.value);
  }
  return names;
}

/** Left-nested `-` chains are the shape a multi-part id parses into. */
function minusOperands(node: AstNode): string[][] | undefined {
  const right = plainSteps(node.rhs);
  if (right === undefined) return undefined;
  const direct = plainSteps(node.lhs);
  if (direct !== undefined) return [direct, right];
  const left = asNode(node.lhs);
  if (left === undefined) return undefined;
  const nested = isMinus(left) ? minusOperands(left) : undefined;
  return nested === undefined ? undefined : [...nested, right];
}

/** The name a reader meant, and how the whole subtree is spelled to read it. */
function joined(
  operands: readonly string[][],
): { name: string; corrected: string } | undefined {
  const first = operands[0];
  const last = operands.at(-1);
  const head = first?.at(-1);
  const tail = last?.[0];
  if (first === undefined || last === undefined) return undefined;
  if (head === undefined || tail === undefined) return undefined;
  const middle: string[] = [];
  for (const steps of operands.slice(1, -1)) {
    const only = steps[0];
    if (steps.length !== 1 || only === undefined) return undefined;
    middle.push(only);
  }
  const name = [head, ...middle, tail].join("-");
  if (!slug.test(name)) return undefined;
  const corrected = [...first.slice(0, -1), `\`${name}\``, ...last.slice(1)];
  return { name, corrected: corrected.join(".") };
}

/** Every hyphenated name this expression subtracts instead of reading. */
export function subtractedNames(
  expression: string,
  names: ReadonlySet<string>,
): { name: string; corrected: string }[] {
  let ast: unknown;
  try {
    ast = jsonata(expression).ast();
  } catch {
    return [];
  }
  const found: { name: string; corrected: string }[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isObject(value)) return;
    const node = asNode(value);
    if (isMinus(node) && node !== undefined) {
      const operands = minusOperands(node);
      const match = operands === undefined ? undefined : joined(operands);
      if (match !== undefined && names.has(match.name)) {
        found.push(match);
        return;
      }
    }
    for (const nested of Object.values(value)) visit(nested);
  };
  visit(ast);
  return found;
}

/** Names a hyphenated expression could only be reading, never subtracting. */
export function blueprintNames(blueprint: Blueprint): Set<string> {
  return new Set(
    [
      ...Object.keys(blueprint.nodes),
      ...Object.keys(blueprint.inputs ?? {}),
      ...Object.keys(blueprint.outputs ?? {}),
    ].filter((name) => name.includes("-")),
  );
}

function contextRefs(value: unknown, path: string): ExpressionSite[] {
  if (Array.isArray(value))
    return value.flatMap((item, index) =>
      contextRefs(item, `${path}[${String(index)}]`),
    );
  if (!isObject(value)) return [];
  const only = Object.keys(value);
  if (only.length === 1 && typeof value["from"] === "string")
    return [{ node: "", where: `${path}.from`, expression: value["from"] }];
  return Object.entries(value).flatMap(([key, nested]) =>
    contextRefs(nested, `${path}.${key}`),
  );
}

/** Every position a blueprint file carries a JSONata expression. */
export function expressionSites(blueprint: Blueprint): ExpressionSite[] {
  const sites: ExpressionSite[] = [];
  for (const edge of blueprint.edges ?? []) {
    if (typeof edge.when === "string")
      sites.push({
        node: edge.from,
        where: `edge to ${edge.to} when`,
        expression: edge.when,
      });
  }
  for (const [nodeId, node] of Object.entries(blueprint.nodes)) {
    const params = node.params ?? {};
    for (const site of contextRefs(params, "params"))
      sites.push({ ...site, node: nodeId });
    if (node.uses === "child-run" && isObject(params["outputs"]))
      for (const [key, mapping] of Object.entries(params["outputs"]))
        if (typeof mapping === "string")
          sites.push({
            node: nodeId,
            where: `params.outputs.${key}`,
            expression: mapping,
          });
    if (node.uses === "on-issue-change") {
      if (typeof params["when"] === "string")
        sites.push({
          node: nodeId,
          where: "params.when",
          expression: params["when"],
        });
      if (isObject(params["bindings"]))
        for (const [key, binding] of Object.entries(params["bindings"]))
          if (typeof binding === "string")
            sites.push({
              node: nodeId,
              where: `params.bindings.${key}`,
              expression: binding,
            });
    }
    if (node.uses === "aggregate" && isObject(params["bindings"]))
      for (const [key, binding] of Object.entries(params["bindings"]))
        if (isObject(binding) && typeof binding["path"] === "string")
          sites.push({
            node: nodeId,
            where: `params.bindings.${key}.path`,
            expression: binding["path"],
          });
  }
  return sites;
}

export const HYPHENATED_NAME_RULE = "expression.hyphenated-name";

export function hyphenatedNameMessage(
  site: ExpressionSite,
  match: { name: string; corrected: string },
): string {
  return `${site.where} subtracts ${match.name} instead of reading it: ${site.expression}; write ${match.corrected}`;
}

/** Findings for every expression site of one blueprint file. */
export function hyphenatedNameFindings(
  file: string,
  blueprint: Blueprint,
): ValidationFinding[] {
  const names = blueprintNames(blueprint);
  if (names.size === 0) return [];
  return expressionSites(blueprint).flatMap((site) =>
    subtractedNames(site.expression, names).map((match) => ({
      file,
      node: site.node,
      rule: HYPHENATED_NAME_RULE,
      message: hyphenatedNameMessage(site, match),
    })),
  );
}

/** Findings for the expressions a policy rule artifact carries. */
export function policyHyphenatedNameFindings(
  file: string,
  rules: readonly unknown[],
): ValidationFinding[] {
  const names = new Set<string>();
  for (const rule of rules) {
    if (!isObject(rule)) continue;
    if (typeof rule["id"] === "string" && rule["id"].includes("-"))
      names.add(rule["id"]);
    if (isObject(rule["inputs"]))
      for (const key of Object.keys(rule["inputs"]))
        if (key.includes("-")) names.add(key);
  }
  if (names.size === 0) return [];
  const findings: ValidationFinding[] = [];
  for (const [index, rule] of rules.entries()) {
    if (!isObject(rule)) continue;
    const node = `/rules/${String(index)}`;
    const sites: ExpressionSite[] = [
      ...(typeof rule["when"] === "string"
        ? [{ node, where: "when", expression: rule["when"] }]
        : []),
      ...contextRefs(rule["inputs"], "inputs").map((site) => ({
        ...site,
        node,
      })),
    ];
    for (const site of sites)
      for (const match of subtractedNames(site.expression, names))
        findings.push({
          file,
          node,
          rule: HYPHENATED_NAME_RULE,
          message: hyphenatedNameMessage(site, match),
        });
  }
  return findings;
}
