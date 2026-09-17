// ---
// relationships:
//   implements: blueprint-authoring
// ---
import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseDocument } from "yaml";

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

export function loadBlueprint(filePath: string): LoadedBlueprint {
  const absolutePath = resolve(filePath);
  const source = readFileSync(absolutePath, "utf8");
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
    originalValue: structuredClone(value),
  };
}

export function saveBlueprint(loaded: LoadedBlueprint): string {
  const currentValue: unknown = loaded.document.toJS({ maxAliasCount: 100 });
  return isDeepStrictEqual(currentValue, loaded.originalValue)
    ? loaded.source
    : loaded.document.toString();
}
