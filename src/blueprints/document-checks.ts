// ---
// relationships:
//   implements:
//     - blueprint-authoring
//     - node-types
// ---
import { deriveFlowcraftBlueprint } from "./flowcraft.js";
import { basename, extname } from "node:path";

import { hyphenatedNameFindings } from "./expression-names.js";
import { lintDerivedBlueprint } from "./flowcraft-lint.js";
import { lintHeddle, validateExpressions } from "./heddle-lint.js";
import { intakeTerminalFindings } from "./intake-terminals.js";
import { validateLiveRequirements } from "./live-checks.js";
import { isNodeTypeName } from "./node-types.js";
import { validateReferences } from "./references.js";
import { resultContractFindings } from "./result-contracts.js";
import {
  checkJsonSchema,
  isObject,
  validateBlueprintSchema,
  validateNodeParams,
} from "./schema-validation.js";
import type {
  Blueprint,
  BlueprintNode,
  JsonObject,
  ValidationFinding,
  ValidationOptions,
} from "./types.js";

export const blueprintNode = "$blueprint";

export function finding(
  file: string,
  node: string,
  rule: string,
  message: string,
): ValidationFinding {
  return { file, node, rule, message };
}

function nodeFromInstancePath(instancePath: string): string {
  const match = /^\/nodes\/([^/]+)/u.exec(instancePath);
  return (
    match?.[1]?.replaceAll("~1", "/").replaceAll("~0", "~") ?? blueprintNode
  );
}

function schemaFindings(file: string, value: unknown): ValidationFinding[] {
  const result = validateBlueprintSchema(value);
  return result.errors.map((error) =>
    finding(
      file,
      nodeFromInstancePath(error.instancePath),
      "blueprint.schema",
      `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
    ),
  );
}

function isTraversableBlueprint(value: JsonObject): boolean {
  const nodes = value["nodes"];
  const edges = value["edges"];
  return (
    typeof value["id"] === "string" &&
    isObject(nodes) &&
    Object.values(nodes).every(
      (node) => isObject(node) && typeof node["uses"] === "string",
    ) &&
    (edges === undefined ||
      (Array.isArray(edges) &&
        edges.every(
          (edge) =>
            isObject(edge) &&
            typeof edge["from"] === "string" &&
            typeof edge["to"] === "string" &&
            (edge["when"] === undefined || typeof edge["when"] === "string"),
        )))
  );
}

function validateParams(
  file: string,
  blueprint: Blueprint,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  for (const [nodeId, node] of Object.entries(blueprint.nodes)) {
    if (!isNodeTypeName(node.uses)) {
      findings.push(
        finding(file, nodeId, "node.params", `Unknown node type: ${node.uses}`),
      );
      continue;
    }
    const result = validateNodeParams(node.uses, node.params);
    for (const error of result.errors) {
      findings.push(
        finding(
          file,
          nodeId,
          "node.params",
          `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
        ),
      );
    }
  }
  return findings;
}

function inlineHandoff(node: BlueprintNode): unknown {
  if (node.uses === "pass") return node.params?.["handoff"];
  if (node.uses === "child-run" && isObject(node.params?.["inputs"])) {
    return node.params["inputs"]["handoff"];
  }
  return undefined;
}

function validateInlineHandoffs(
  file: string,
  blueprint: Blueprint,
): ValidationFinding[] {
  return Object.entries(blueprint.nodes).flatMap(([nodeId, node]) => {
    const handoff = inlineHandoff(node);
    return isObject(handoff)
      ? checkJsonSchema(handoff).map((message) =>
          finding(file, nodeId, "handoff.schema", message),
        )
      : [];
  });
}

function flowcraftFindings(
  file: string,
  blueprint: Blueprint,
): ValidationFinding[] {
  return lintDerivedBlueprint(blueprint).map((issue) =>
    finding(
      file,
      issue.nodeId ?? issue.relatedId ?? blueprintNode,
      "flowcraft.lint",
      `${issue.code}: ${issue.message}`,
    ),
  );
}

/** Every file-local check one loaded document answers on its own. */
export function validateLoaded(
  file: string,
  value: unknown,
  options: ValidationOptions,
): ValidationFinding[] {
  const findings = schemaFindings(file, value);
  if (!isObject(value) || !isTraversableBlueprint(value)) return findings;
  const blueprint = value as unknown as Blueprint;
  const expectedId = basename(file, extname(file));
  if (blueprint.id !== expectedId) {
    findings.push(
      finding(
        file,
        blueprintNode,
        "blueprint.id",
        `Expected id: ${expectedId}`,
      ),
    );
  }
  findings.push(
    ...validateParams(file, blueprint),
    ...validateReferences(file, blueprint, options),
    ...validateInlineHandoffs(file, blueprint),
    ...validateExpressions(file, blueprint),
    ...hyphenatedNameFindings(file, blueprint),
    ...intakeTerminalFindings(file, blueprint),
    ...lintHeddle(file, blueprint, options),
    ...flowcraftFindings(file, blueprint),
    ...resultContractFindings(deriveFlowcraftBlueprint(blueprint)).map((item) =>
      finding(file, item.node, "heddle.result-contract", item.message),
    ),
  );
  findings.push(...validateLiveRequirements(file, blueprint, options));
  return findings;
}
