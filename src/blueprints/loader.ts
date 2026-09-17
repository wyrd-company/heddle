// ---
// relationships:
//   implements: blueprint-authoring
// ---
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isMap,
  isScalar,
  parseDocument,
  type Document,
  type Scalar,
} from "yaml";

import { saveLocalizedYaml } from "./source-preserving-yaml.js";
import type { Blueprint, LoadedBlueprint } from "./types.js";

export class BlueprintParseError extends Error {
  public constructor(
    message: string,
    public readonly filePath: string,
  ) {
    super(message);
    this.name = "BlueprintParseError";
  }
}

function parseBlueprintSource(
  source: string,
  absolutePath: string,
): LoadedBlueprint {
  const document = parseDocument(source, {
    keepSourceTokens: true,
    prettyErrors: false,
    strict: true,
  });

  if (document.errors.length > 0) {
    throw new BlueprintParseError(
      document.errors.map((error) => error.message).join("; "),
      absolutePath,
    );
  }

  const value: unknown = document.toJS({ maxAliasCount: 100 });
  return {
    filePath: absolutePath,
    source,
    document,
    blueprint: value as Blueprint,
    formattedSource: document.toString(),
    originalValue: structuredClone(value),
  };
}

export function loadBlueprint(filePath: string): LoadedBlueprint {
  const absolutePath = resolve(filePath);
  return parseBlueprintSource(readFileSync(absolutePath, "utf8"), absolutePath);
}

export function saveBlueprint(loaded: LoadedBlueprint): string {
  return saveLocalizedYaml(
    loaded.source,
    loaded.formattedSource,
    loaded.document,
  );
}

function firstKey(document: Document): Scalar | undefined {
  if (!isMap(document.contents)) return undefined;
  const key = document.contents.items[0]?.key;
  return isScalar(key) ? key : undefined;
}

export function roundTripBlueprintBytes(loaded: LoadedBlueprint): boolean {
  const originalKey = firstKey(loaded.document);
  if (originalKey === undefined) return false;
  const originalComment = originalKey.commentBefore ?? null;
  const editedDocument = loaded.document.clone();
  const editedKey = firstKey(editedDocument);
  if (editedKey === undefined) return false;
  editedKey.commentBefore = [originalComment, "roundtrip byte check"]
    .filter((value) => value !== null)
    .join("\n");
  const editedSource = saveBlueprint({ ...loaded, document: editedDocument });
  const restored = parseBlueprintSource(editedSource, loaded.filePath);
  const restoredKey = firstKey(restored.document);
  if (restoredKey === undefined) return false;
  restoredKey.commentBefore = originalComment;
  return saveBlueprint(restored) === loaded.source;
}
