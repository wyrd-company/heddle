// ---
// relationships:
//   implements: blueprint-authoring
// ---
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { isObject } from "./schema-validation.js";
import type { Blueprint, BlueprintNode, ValidationFinding } from "./types.js";

/** Template inputs whose text may load further templates through the loader. */
function collectTemplates(
  nodeId: string,
  node: BlueprintNode,
): { node: string; value: unknown }[] {
  const params = node.params ?? {};
  const values: unknown[] =
    node.uses === "pass"
      ? [params["prompt"]]
      : node.uses === "notify"
        ? [params["title"], params["message"]]
        : node.uses === "child-run" && isObject(params["inputs"])
          ? [params["inputs"]["prompt"]]
          : [];
  return values
    .filter((value) => value !== undefined)
    .map((value) => ({ node: nodeId, value }));
}

function templateText(directory: string, value: unknown): string | undefined {
  if (isObject(value) && typeof value["inline"] === "string")
    return value["inline"];
  if (typeof value !== "string") return undefined;
  try {
    return readFileSync(resolve(directory, value), "utf8");
  } catch {
    // A missing or escaping path is already reported as reference.exists.
    return undefined;
  }
}

/**
 * Literal template-loading targets resolve from the blueprint root, so they
 * are only checkable when a whole blueprint root is validated.
 */
export function validateIncludes(
  root: string,
  inventory: readonly { filePath: string; blueprint: Blueprint }[],
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  for (const { filePath, blueprint } of inventory) {
    const directory = dirname(filePath);
    for (const [nodeId, node] of Object.entries(blueprint.nodes))
      for (const template of collectTemplates(nodeId, node)) {
        const text = templateText(directory, template.value);
        if (text === undefined) continue;
        for (const match of text.matchAll(
          /\{%-?\s*(?:include|import|extends)\s+"([^"]*)"/gu,
        )) {
          const target = match[1];
          if (target === undefined) continue;
          const resolved = resolve(root, target);
          const displacement = relative(root, resolved);
          if (
            isAbsolute(target) ||
            displacement === ".." ||
            displacement.startsWith(`..${sep}`)
          ) {
            findings.push({
              file: filePath,
              node: template.node,
              rule: "reference.exists",
              message: `Included template must stay inside the blueprint root (${target})`,
              reference: target,
            });
            continue;
          }
          try {
            if (!statSync(resolved).isFile()) throw new Error("is not a file");
          } catch {
            findings.push({
              file: filePath,
              node: template.node,
              rule: "reference.exists",
              message: `Included template does not exist in the blueprint root (${target})`,
              reference: target,
            });
          }
        }
      }
  }
  return findings;
}
