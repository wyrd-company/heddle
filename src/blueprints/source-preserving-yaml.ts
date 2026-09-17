import { isDeepStrictEqual } from "node:util";

import {
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  stringify,
  type Document,
  type Node,
} from "yaml";

import { applyLocalizedLineEdits } from "./yaml-line-edits.js";

interface SourcePatch {
  readonly end: number;
  readonly replacement: string;
  readonly start: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodeAt(document: Document, path: readonly (number | string)[]): Node {
  const value =
    path.length === 0 ? document.contents : document.getIn(path, true);
  return isNode(value) ? value : document.createNode(value);
}

function renderReplacement(
  document: Document,
  originalNode: Node,
  editedNode: Node,
  source: string,
): string {
  const replacement = document.createNode(editedNode.toJSON());
  if (isScalar(originalNode) && isScalar(replacement)) {
    if (originalNode.type !== undefined) replacement.type = originalNode.type;
  } else if (isMap(originalNode) && isMap(replacement)) {
    if (originalNode.flow !== undefined) replacement.flow = originalNode.flow;
  } else if (isSeq(originalNode) && isSeq(replacement)) {
    if (originalNode.flow !== undefined) replacement.flow = originalNode.flow;
  }

  const start = originalNode.range?.[0];
  if (start === undefined) {
    throw new Error("Cannot preserve YAML source for a node without a range");
  }
  const lineStart = Math.max(source.lastIndexOf("\n", start - 1) + 1, 0);
  const indentation = " ".repeat(start - lineStart);
  return stringify(replacement, { lineWidth: 0 })
    .replace(/\n$/u, "")
    .replaceAll("\n", `\n${indentation}`);
}

function semanticPatches(
  originalDocument: Document,
  editedDocument: Document,
  source: string,
): SourcePatch[] {
  const patches: SourcePatch[] = [];

  function visit(
    originalValue: unknown,
    editedValue: unknown,
    path: readonly (number | string)[],
  ): void {
    if (isDeepStrictEqual(originalValue, editedValue)) return;

    if (
      Array.isArray(originalValue) &&
      Array.isArray(editedValue) &&
      originalValue.length === editedValue.length
    ) {
      originalValue.forEach((value, index) => {
        visit(value, editedValue[index], [...path, index]);
      });
      return;
    }

    if (isRecord(originalValue) && isRecord(editedValue)) {
      const originalKeys = Object.keys(originalValue);
      const editedKeys = Object.keys(editedValue);
      if (
        originalKeys.length === editedKeys.length &&
        originalKeys.every((key, index) => key === editedKeys[index])
      ) {
        originalKeys.forEach((key) => {
          visit(originalValue[key], editedValue[key], [...path, key]);
        });
        return;
      }
    }

    const originalNode = nodeAt(originalDocument, path);
    const editedNode = nodeAt(editedDocument, path);
    const range = originalNode.range;
    if (range == null) {
      throw new Error(`Cannot preserve YAML source at ${path.join(".")}`);
    }
    patches.push({
      start: range[0],
      end: range[1],
      replacement: renderReplacement(
        editedDocument,
        originalNode,
        editedNode,
        source,
      ),
    });
  }

  visit(
    originalDocument.toJS({ maxAliasCount: 100 }),
    editedDocument.toJS({ maxAliasCount: 100 }),
    [],
  );
  return patches;
}

function applySourcePatches(
  source: string,
  patches: readonly SourcePatch[],
): string {
  let saved = source;
  let previousStart = source.length;
  for (const patch of [...patches].sort(
    (left, right) => right.start - left.start,
  )) {
    if (patch.end > previousStart) {
      throw new Error("Overlapping YAML edits cannot preserve source bytes");
    }
    saved = `${saved.slice(0, patch.start)}${patch.replacement}${saved.slice(patch.end)}`;
    previousStart = patch.start;
  }
  return saved;
}

function assertSemanticSave(saved: string, editedDocument: Document): void {
  const reparsed = parseDocument(saved, {
    keepSourceTokens: true,
    prettyErrors: false,
    strict: true,
  });
  if (
    reparsed.errors.length > 0 ||
    !isDeepStrictEqual(
      reparsed.toJS({ maxAliasCount: 100 }),
      editedDocument.toJS({ maxAliasCount: 100 }),
    )
  ) {
    throw new Error("Localized YAML edit did not preserve the edited document");
  }
}

export function saveLocalizedYaml(
  source: string,
  formattedSource: string,
  editedDocument: Document,
): string {
  const formattedEdit = editedDocument.toString();
  if (formattedEdit === formattedSource) return source;

  const originalDocument = parseDocument(source, {
    keepSourceTokens: true,
    prettyErrors: false,
    strict: true,
  });
  const patches = semanticPatches(originalDocument, editedDocument, source);
  const saved =
    patches.length > 0
      ? applySourcePatches(source, patches)
      : applyLocalizedLineEdits(source, formattedSource, formattedEdit);
  assertSemanticSave(saved, editedDocument);
  return saved;
}
