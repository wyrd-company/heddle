// ---
// relationships:
//   verifies: node-types
// ---
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TemplateSource } from "../../src/templates/index.js";

/** A template source over explicit readers; repository reads are refused. */
export function templateSource(
  read: (
    commit: string,
    blueprintId: string,
    path: string,
  ) => Promise<string>,
  readFromRoot: (commit: string, path: string) => Promise<string> = (
    _commit,
    path,
  ) => Promise.reject(new Error(`unexpected repository read: ${path}`)),
): TemplateSource {
  return { read, readFromRoot };
}

/** A template source over a directory on disk, for graph-only fixtures. */
export function directoryTemplates(
  blueprintDirectory: string,
  root = blueprintDirectory,
): TemplateSource {
  return templateSource(
    (_commit, _blueprintId, path) =>
      Promise.resolve(readFileSync(join(blueprintDirectory, path), "utf8")),
    (_commit, path) =>
      Promise.resolve(readFileSync(join(root, path), "utf8")),
  );
}
