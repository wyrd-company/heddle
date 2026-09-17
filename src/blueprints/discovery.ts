// ---
// relationships:
//   implements: blueprint-authoring
// ---
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { parseDocument } from "yaml";

import { isObject } from "./schema-validation.js";

function isBlueprintCandidate(filePath: string): boolean {
  const document = parseDocument(readFileSync(filePath, "utf8"), {
    prettyErrors: false,
    strict: true,
  });
  if (document.errors.length > 0) return true;
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 100 });
  } catch {
    return true;
  }
  return (
    isObject(value) &&
    ["id", "kind", "nodes", "edges"].some((key) => Object.hasOwn(value, key))
  );
}

export function discoverBlueprintFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...discoverBlueprintFiles(path));
    else if (/\.ya?ml$/u.test(entry.name) && isBlueprintCandidate(path)) {
      files.push(path);
    }
  }
  return files.sort();
}

export const inputIsDirectory = (path: string): boolean =>
  statSync(path).isDirectory();
