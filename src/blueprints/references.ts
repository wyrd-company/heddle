// ---
// relationships:
//   implements: blueprint-authoring
// ---
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { parseDocument } from "yaml";

import { checkJsonSchema, isObject } from "./schema-validation.js";
import type { Blueprint, BlueprintNode, ValidationFinding } from "./types.js";

interface Reference {
  readonly handoff: boolean;
  readonly node: string;
  readonly path: string;
}

function addReference(
  references: Reference[],
  node: string,
  value: unknown,
  handoff = false,
): void {
  if (typeof value === "string") {
    references.push({ handoff, node, path: value });
  }
}

function collectNodeReferences(
  nodeId: string,
  node: BlueprintNode,
): Reference[] {
  const references: Reference[] = [];
  const params = node.params ?? {};
  if (node.uses === "pass") {
    addReference(references, nodeId, params["prompt"]);
    addReference(references, nodeId, params["handoff"], true);
  }
  if (node.uses === "question" && Array.isArray(params["questions"])) {
    for (const question of params["questions"]) {
      if (isObject(question)) {
        addReference(references, nodeId, question["question"]);
      }
    }
  }
  if (node.uses === "notify") {
    addReference(references, nodeId, params["title"]);
    addReference(references, nodeId, params["message"]);
  }
  if (node.uses === "policy") {
    addReference(references, nodeId, params["rules"]);
  }
  if (node.uses === "child-run" && isObject(params["inputs"])) {
    addReference(references, nodeId, params["inputs"]["prompt"]);
    addReference(references, nodeId, params["inputs"]["handoff"], true);
  }
  return references;
}

export function validateReferences(
  filePath: string,
  blueprint: Blueprint,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const directory = dirname(filePath);
  for (const [nodeId, node] of Object.entries(blueprint.nodes)) {
    for (const reference of collectNodeReferences(nodeId, node)) {
      const referencedPath = resolve(directory, reference.path);
      const relativePath = relative(directory, referencedPath);
      if (
        isAbsolute(reference.path) ||
        relativePath === ".." ||
        relativePath.startsWith(
          `..${process.platform === "win32" ? "\\" : "/"}`,
        )
      ) {
        continue;
      }
      try {
        if (!statSync(referencedPath).isFile()) {
          throw new Error("is not a file");
        }
      } catch {
        findings.push({
          file: filePath,
          node: reference.node,
          rule: "reference.exists",
          message: `Referenced file does not exist: ${reference.path}`,
        });
        continue;
      }

      if (reference.handoff) {
        const document = parseDocument(readFileSync(referencedPath, "utf8"), {
          prettyErrors: false,
          strict: true,
        });
        const errors =
          document.errors.length === 0
            ? checkJsonSchema(document.toJS({ maxAliasCount: 100 }))
            : document.errors.map((error) => error.message);
        for (const message of errors) {
          findings.push({
            file: referencedPath,
            node: reference.node,
            rule: "handoff.schema",
            message,
          });
        }
      }
    }
  }
  return findings;
}
