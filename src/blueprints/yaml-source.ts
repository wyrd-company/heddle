// ---
// relationships:
//   implements: blueprint-authoring
// ---
import { parseDocument, type Document } from "yaml";

export interface SourcePatch {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

export function applySourcePatches(
  source: string,
  patches: readonly SourcePatch[],
): string {
  let saved = source;
  let previousStart = source.length;
  for (const patch of [...patches].sort(
    (a, b) => b.start - a.start || b.end - a.end,
  )) {
    if (patch.end > previousStart)
      throw new Error("Overlapping YAML edits cannot preserve source bytes");
    saved =
      saved.slice(0, patch.start) + patch.replacement + saved.slice(patch.end);
    previousStart = patch.start;
  }
  return saved;
}

export function parseSource(source: string): Document {
  return parseDocument(source, {
    keepSourceTokens: true,
    prettyErrors: false,
    strict: true,
  });
}
