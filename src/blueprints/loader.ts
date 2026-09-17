// ---
// relationships:
//   implements: blueprint-authoring
// ---
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { isScalar, parseDocument } from "yaml";

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

interface Line {
  readonly body: string;
  readonly ending: string;
}

interface Match {
  readonly left: number;
  readonly right: number;
}

interface Hunk {
  readonly end: number;
  readonly replacement: readonly Line[];
  readonly start: number;
}

function lines(value: string): Line[] {
  return [...value.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/gu)]
    .filter((match) => match[0].length > 0)
    .map((match) => ({ body: match[1] ?? "", ending: match[2] ?? "" }));
}

function matchingLines(left: readonly Line[], right: readonly Line[]): Match[] {
  const lengths = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0),
  );
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    const row = lengths[leftIndex];
    if (row === undefined) continue;
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      row[rightIndex] =
        left[leftIndex]?.body === right[rightIndex]?.body
          ? (lengths[leftIndex + 1]?.[rightIndex + 1] ?? 0) + 1
          : Math.max(
              lengths[leftIndex + 1]?.[rightIndex] ?? 0,
              lengths[leftIndex]?.[rightIndex + 1] ?? 0,
            );
    }
  }
  const matches: Match[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex]?.body === right[rightIndex]?.body) {
      matches.push({ left: leftIndex, right: rightIndex });
      leftIndex += 1;
      rightIndex += 1;
    } else if (
      (lengths[leftIndex + 1]?.[rightIndex] ?? 0) >=
      (lengths[leftIndex]?.[rightIndex + 1] ?? 0)
    ) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
  return matches;
}

function changedHunks(base: readonly Line[], edited: readonly Line[]): Hunk[] {
  const boundaries = [
    { left: -1, right: -1 },
    ...matchingLines(base, edited),
    { left: base.length, right: edited.length },
  ];
  const hunks: Hunk[] = [];
  for (let index = 1; index < boundaries.length; index += 1) {
    const previous = boundaries[index - 1];
    const next = boundaries[index];
    if (previous === undefined || next === undefined) continue;
    const start = previous.left + 1;
    const end = next.left;
    const replacement = edited.slice(previous.right + 1, next.right);
    if (start !== end || replacement.length > 0) {
      hunks.push({ start, end, replacement });
    }
  }
  return hunks;
}

function sourceRange(
  hunk: Hunk,
  matches: readonly Match[],
  sourceLength: number,
): { readonly end: number; readonly start: number } {
  const exactStart = matches.find((match) => match.left === hunk.start);
  const previous = [...matches]
    .reverse()
    .find((match) => match.left < hunk.start);
  const exactEnd = matches.find((match) => match.left === hunk.end - 1);
  const next = matches.find((match) => match.left >= hunk.end);
  const start = exactStart?.right ?? (previous?.right ?? -1) + 1;
  const end =
    hunk.end === hunk.start
      ? start
      : (exactEnd?.right ?? (next?.right ?? sourceLength) - 1) + 1;
  return { start, end };
}

function preferredEnding(source: readonly Line[]): string {
  const endings = source.map((line) => line.ending).filter(Boolean);
  return endings.find((ending) => ending === "\r\n") ?? endings[0] ?? "\n";
}

function applyLocalizedEdits(
  sourceText: string,
  formattedSource: string,
  formattedEdit: string,
): string {
  const source = lines(sourceText);
  const base = lines(formattedSource);
  const edited = lines(formattedEdit);
  const sourceMatches = matchingLines(base, source);
  const ending = preferredEnding(source);
  const patches = changedHunks(base, edited)
    .map((hunk) => ({
      ...sourceRange(hunk, sourceMatches, source.length),
      hunk,
    }))
    .sort((left, right) => right.start - left.start);
  let previousStart = source.length;
  for (const patch of patches) {
    if (patch.end > previousStart) {
      throw new Error("Overlapping YAML edits cannot preserve source bytes");
    }
    const replacement = patch.hunk.replacement.map((line) => ({
      body: line.body,
      ending: line.ending.length > 0 ? ending : "",
    }));
    source.splice(patch.start, patch.end - patch.start, ...replacement);
    previousStart = patch.start;
  }
  return source.map((line) => `${line.body}${line.ending}`).join("");
}

export function saveBlueprint(loaded: LoadedBlueprint): string {
  const formattedEdit = loaded.document.toString();
  return formattedEdit === loaded.formattedSource
    ? loaded.source
    : applyLocalizedEdits(loaded.source, loaded.formattedSource, formattedEdit);
}

export function roundTripBlueprintBytes(loaded: LoadedBlueprint): boolean {
  const id = loaded.document.getIn(["id"], true);
  if (!isScalar(id) || typeof id.value !== "string") return false;
  const editedDocument = loaded.document.clone();
  editedDocument.setIn(["id"], `${id.value}-roundtrip`);
  const editedSource = saveBlueprint({ ...loaded, document: editedDocument });
  const restored = parseBlueprintSource(editedSource, loaded.filePath);
  restored.document.setIn(["id"], id.value);
  return saveBlueprint(restored) === loaded.source;
}
