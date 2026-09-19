// ---
// relationships:
//   implements:
//     - blueprint-authoring
//     - node-types
// ---
import { repositoryContractFindings } from "./repository-contracts.js";
import { resolve } from "node:path";

import { blueprintNode, finding, validateLoaded } from "./document-checks.js";
import { discoverBlueprintFiles, inputIsDirectory } from "./discovery.js";
import {
  BlueprintParseError,
  loadBlueprint,
  roundTripBlueprintBytes,
} from "./loader.js";
import { validateIncludes } from "./template-includes.js";
import type {
  BlueprintCheckResult,
  LoadedBlueprint,
  ValidationFinding,
  ValidationOptions,
} from "./types.js";

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
    const message = error instanceof Error ? error.message : String(error);
    return [finding(path, blueprintNode, "input.path", message)];
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
  const rooted = directoryInput ? { ...options, blueprintRoot: path } : options;
  const checked = files.map((file) => checkBlueprintFile(file, rooted));
  const findings = checked.flatMap((result) => result.findings);
  // A directory is the complete blueprint root inventory, nested folders included.
  if (directoryInput) {
    const loaded = checked.flatMap((result) =>
      result.loaded === undefined ? [] : [result.loaded],
    );
    findings.push(
      ...repositoryContractFindings(loaded),
      ...validateIncludes(path, loaded),
    );
  }
  return sortFindings(findings);
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
