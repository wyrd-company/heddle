// ---
// relationships:
//   implements: blueprint-authoring
// ---
import { readFileSync, realpathSync, statSync } from "node:fs";
import { relative, sep } from "node:path";

import jsonata from "jsonata";
import { parseDocument } from "yaml";

import {
  checkJsonSchema,
  isObject,
  validatePolicyRuleSchema,
} from "./schema-validation.js";
import { blueprintRootFor, resolveBlueprintPath } from "./root.js";
import type {
  Blueprint,
  BlueprintNode,
  ValidationFinding,
  ValidationOptions,
} from "./types.js";

interface Reference {
  readonly kind: "file" | "handoff" | "policy";
  readonly node: string;
  readonly path: string;
}

function addReference(
  references: Reference[],
  node: string,
  value: unknown,
  kind: Reference["kind"] = "file",
): void {
  if (typeof value === "string") {
    references.push({ kind, node, path: value });
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
    addReference(references, nodeId, params["handoff"], "handoff");
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
    addReference(references, nodeId, params["rules"], "policy");
  }
  if (node.uses === "child-run" && isObject(params["inputs"])) {
    addReference(references, nodeId, params["inputs"]["prompt"]);
    addReference(references, nodeId, params["inputs"]["handoff"], "handoff");
  }
  return references;
}

export function validateReferences(
  filePath: string,
  blueprint: Blueprint,
  options: ValidationOptions,
): ValidationFinding[] {
  const blueprintRoot = blueprintRootFor(
    options.blueprintRoot,
    filePath,
    false,
  );
  const findings: ValidationFinding[] = [];
  const realRoot = realpathSync(blueprintRoot);
  for (const [nodeId, node] of Object.entries(blueprint.nodes)) {
    for (const reference of collectNodeReferences(nodeId, node)) {
      const referencedPath = resolveBlueprintPath(
        blueprintRoot,
        reference.path,
      );
      if (referencedPath === undefined) {
        findings.push({
          file: filePath,
          node: reference.node,
          rule: "reference.exists",
          message: `Referenced file must stay inside the blueprint root (${reference.path})`,
          reference: reference.path,
        });
        continue;
      }
      try {
        if (!statSync(referencedPath).isFile()) {
          throw new Error("is not a file");
        }
        const realReferencedPath = realpathSync(referencedPath);
        const realRelativePath = relative(realRoot, realReferencedPath);
        if (
          realRelativePath === ".." ||
          realRelativePath.startsWith(`..${sep}`)
        ) {
          findings.push({
            file: filePath,
            node: reference.node,
            rule: "reference.exists",
            message: `Referenced file must stay inside the blueprint root (${reference.path})`,
            reference: reference.path,
          });
          continue;
        }
      } catch {
        findings.push({
          file: filePath,
          node: reference.node,
          rule: "reference.exists",
          message: `Referenced file does not exist (${reference.path})`,
          reference: reference.path,
        });
        continue;
      }

      if (reference.kind === "handoff") {
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
      if (reference.kind === "policy") {
        const document = parseDocument(readFileSync(referencedPath, "utf8"), {
          prettyErrors: false,
          strict: true,
        });
        if (document.errors.length > 0) {
          for (const error of document.errors) {
            findings.push({
              file: referencedPath,
              node: "$policy",
              rule: "policy.schema",
              message: error.message,
            });
          }
          continue;
        }
        let value: unknown;
        try {
          value = document.toJS({ maxAliasCount: 100 });
        } catch (error) {
          findings.push({
            file: referencedPath,
            node: "$policy",
            rule: "policy.schema",
            message: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        const result = validatePolicyRuleSchema(value);
        for (const error of result.errors) {
          findings.push({
            file: referencedPath,
            node: schemaErrorLocation(error),
            rule: "policy.schema",
            message: error.message ?? "is invalid",
          });
        }
        if (result.valid && isObject(value) && Array.isArray(value["rules"])) {
          const ruleIds = new Set<string>();
          let fallbackIndex: number | undefined;
          for (const [index, rule] of value["rules"].entries()) {
            if (!isObject(rule) || typeof rule["id"] !== "string") continue;
            if (ruleIds.has(rule["id"])) {
              findings.push({
                file: referencedPath,
                node: `/rules/${String(index)}/id`,
                rule: "policy.rule-id",
                message: `Duplicate rule id: ${rule["id"]}`,
              });
            }
            ruleIds.add(rule["id"]);
            if (fallbackIndex !== undefined) {
              findings.push({
                file: referencedPath,
                node: `/rules/${String(index)}`,
                rule: "policy.fallback-order",
                message: `Rule cannot follow fallback at /rules/${String(fallbackIndex)}`,
              });
            }
            if (!Object.hasOwn(rule, "when")) {
              fallbackIndex ??= index;
              continue;
            }
            if (typeof rule["when"] !== "string") continue;
            try {
              jsonata(rule["when"]);
            } catch (error) {
              findings.push({
                file: referencedPath,
                node: `/rules/${String(index)}/when`,
                rule: "expression.jsonata",
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      }
    }
  }
  return findings;
}

function schemaErrorLocation(error: {
  readonly instancePath: string;
  readonly keyword: string;
  readonly params: Record<string, unknown>;
}): string {
  const property =
    error.keyword === "required"
      ? error.params["missingProperty"]
      : error.keyword === "additionalProperties"
        ? error.params["additionalProperty"]
        : undefined;
  if (typeof property !== "string") return error.instancePath || "/";
  const escaped = property.replaceAll("~", "~0").replaceAll("/", "~1");
  return `${error.instancePath}/${escaped}`;
}
