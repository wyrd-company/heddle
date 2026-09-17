// ---
// relationships:
//   implements:
//     - blueprint-authoring
//     - node-types
// ---
import { basename, extname, resolve } from "node:path";

import { discoverBlueprintFiles, inputIsDirectory } from "./discovery.js";
import { lintDerivedBlueprint } from "./flowcraft-lint.js";
import { lintHeddle, validateExpressions } from "./heddle-lint.js";
import { validateLiveRequirements } from "./live-checks.js";
import {
  BlueprintParseError,
  loadBlueprint,
  roundTripBlueprintBytes,
} from "./loader.js";
import { isNodeTypeName } from "./node-types.js";
import { validateReferences } from "./references.js";
import {
  checkJsonSchema,
  isObject,
  validateBlueprintSchema,
  validateNodeParams,
} from "./schema-validation.js";
import type {
  Blueprint,
  BlueprintCheckResult,
  BlueprintNode,
  JsonObject,
  LoadedBlueprint,
  ValidationFinding,
  ValidationOptions,
} from "./types.js";

const blueprintNode = "$blueprint";

function finding(
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

function validateLoaded(
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
    ...validateReferences(file, blueprint),
    ...validateInlineHandoffs(file, blueprint),
    ...validateExpressions(file, blueprint),
    ...lintHeddle(file, blueprint, options),
    ...flowcraftFindings(file, blueprint),
  );
  findings.push(...validateLiveRequirements(file, blueprint, options));
  return findings;
}

export function validateBlueprintFile(
  filePath: string,
  options: ValidationOptions = {},
): ValidationFinding[] {
  return [...checkBlueprintFile(filePath, options).findings];
}

export function checkBlueprintFile(
  filePath: string,
  options: ValidationOptions = {},
): BlueprintCheckResult {
  const file = resolve(filePath);
  let loaded: LoadedBlueprint;
  try {
    loaded = loadBlueprint(file);
  } catch (error) {
    const rule =
      error instanceof BlueprintParseError ? "yaml.parse" : "input.path";
    return {
      findings: [
        finding(
          file,
          blueprintNode,
          rule,
          error instanceof Error ? error.message : String(error),
        ),
      ],
    };
  }
  const findings = validateLoaded(file, loaded.blueprint, options);
  if (!roundTripBlueprintBytes(loaded)) {
    findings.push(
      finding(
        file,
        blueprintNode,
        "roundtrip.bytes",
        "Unchanged save changed bytes",
      ),
    );
  }
  return { findings: sortFindings(findings), loaded };
}

export class BlueprintValidationError extends Error {
  public constructor(public readonly findings: readonly ValidationFinding[]) {
    super(findings.map((item) => `${item.rule}: ${item.message}`).join("; "));
    this.name = "BlueprintValidationError";
  }
}

export function loadValidatedBlueprint(
  filePath: string,
  options: ValidationOptions = {},
): LoadedBlueprint {
  const result = checkBlueprintFile(filePath, options);
  if (result.findings.length > 0 || result.loaded === undefined) {
    throw new BlueprintValidationError(result.findings);
  }
  return result.loaded;
}

export function validateBlueprintPath(
  inputPath: string,
  options: ValidationOptions = {},
): ValidationFinding[] {
  const path = resolve(inputPath);
  let files: string[];
  let directoryInput: boolean;
  try {
    directoryInput = inputIsDirectory(path);
    files = directoryInput ? discoverBlueprintFiles(path) : [path];
  } catch (error) {
    return [
      finding(
        path,
        blueprintNode,
        "input.path",
        error instanceof Error ? error.message : String(error),
      ),
    ];
  }
  if (directoryInput && files.length === 0) {
    return [
      finding(
        path,
        blueprintNode,
        "input.path",
        "No blueprint files found in directory",
      ),
    ];
  }
  return sortFindings(
    files.flatMap((file) => validateBlueprintFile(file, options)),
  );
}

function sortFindings(findings: ValidationFinding[]): ValidationFinding[] {
  return findings.sort((left, right) =>
    [left.file, left.node, left.rule, left.message]
      .join("\0")
      .localeCompare(
        [right.file, right.node, right.rule, right.message].join("\0"),
      ),
  );
}
