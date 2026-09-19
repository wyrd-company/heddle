// ---
// relationships:
//   verifies: node-types
// ---
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TemplateSource } from "../../src/templates/index.js";

/** A template source over one explicit blueprint-root reader. */
export function templateSource(
  read: (commit: string, path: string) => Promise<string>,
): TemplateSource {
  return { read };
}

/** A template source over a blueprint root on disk, for graph-only fixtures. */
export function directoryTemplates(root: string): TemplateSource {
  return templateSource((_commit, path) =>
    Promise.resolve(readFileSync(join(root, path), "utf8")),
  );
}
