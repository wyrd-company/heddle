// ---
// relationships:
//   implements: heddle
// ---

import { BlueprintValidationError } from "./errors.js";

const scanStringEnd = (source: string, start: number): number => {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === '"') return index + 1;
  }
  throw new BlueprintValidationError(
    "Blueprint contains an unterminated string",
  );
};

const scanValueEnd = (source: string, start: number): number => {
  const first = source[start];
  if (first === '"') return scanStringEnd(source, start);
  if (first !== "{" && first !== "[") {
    let index = start;
    while (index < source.length && !/[,}\]]/.test(source[index]!)) index += 1;
    return index;
  }
  const close = first === "{" ? "}" : "]";
  let depth = 1;
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '"') {
      index = scanStringEnd(source, index) - 1;
      continue;
    }
    if (source[index] === first) depth += 1;
    if (source[index] === close) depth -= 1;
    if (depth === 0) return index + 1;
  }
  throw new BlueprintValidationError(
    "Blueprint contains an unterminated value",
  );
};

interface SourceItem {
  end: number;
  start: number;
  value: Record<string, unknown>;
}

const arrayItems = (source: string, property: string): SourceItem[] => {
  let index = 1;
  while (index < source.length) {
    while (/\s|,/.test(source[index] ?? "")) index += 1;
    if (source[index] === "}") break;
    if (source[index] !== '"') {
      throw new BlueprintValidationError(
        "Blueprint top level must be an object",
      );
    }
    const keyEnd = scanStringEnd(source, index);
    const key = JSON.parse(source.slice(index, keyEnd)) as string;
    index = keyEnd;
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (source[index] !== ":") {
      throw new BlueprintValidationError(
        "Blueprint property is missing a colon",
      );
    }
    index += 1;
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (key !== property) {
      index = scanValueEnd(source, index);
      continue;
    }
    if (source[index] !== "[") {
      throw new BlueprintValidationError(
        `Blueprint ${property} must be an array`,
      );
    }
    const items: SourceItem[] = [];
    index += 1;
    while (index < source.length) {
      while (/\s|,/.test(source[index] ?? "")) index += 1;
      if (source[index] === "]") return items;
      const start = index;
      const end = scanValueEnd(source, start);
      const value = JSON.parse(source.slice(start, end)) as Record<
        string,
        unknown
      >;
      items.push({ end, start, value });
      index = end;
    }
  }
  throw new BlueprintValidationError(`Blueprint is missing ${property}`);
};

const edgeKeys = (items: SourceItem[]): string[] => {
  const occurrences = new Map<string, number>();
  return items.map(({ value }) => {
    const pair = `${String(value["source"])}\u0000${String(value["target"])}`;
    const occurrence = occurrences.get(pair) ?? 0;
    occurrences.set(pair, occurrence + 1);
    return `${pair}\u0000${occurrence}`;
  });
};

export const preserveUnchangedGraphBytes = (
  original: string,
  candidate: string,
): string => {
  const replacements: Array<{ end: number; source: string; start: number }> =
    [];
  for (const property of ["nodes", "edges"] as const) {
    const originalItems = arrayItems(original, property);
    const candidateItems = arrayItems(candidate, property);
    const originalKeys =
      property === "nodes"
        ? originalItems.map(({ value }) => String(value["id"]))
        : edgeKeys(originalItems);
    const candidateKeys =
      property === "nodes"
        ? candidateItems.map(({ value }) => String(value["id"]))
        : edgeKeys(candidateItems);
    const originals = new Map(
      originalItems.map((item, itemIndex) => [originalKeys[itemIndex], item]),
    );
    candidateItems.forEach((item, itemIndex) => {
      const originalItem = originals.get(candidateKeys[itemIndex]);
      if (
        originalItem !== undefined &&
        JSON.stringify(originalItem.value) === JSON.stringify(item.value)
      ) {
        replacements.push({
          end: item.end,
          source: original.slice(originalItem.start, originalItem.end),
          start: item.start,
        });
      }
    });
  }
  return replacements
    .sort((left, right) => right.start - left.start)
    .reduce(
      (serialized, replacement) =>
        serialized.slice(0, replacement.start) +
        replacement.source +
        serialized.slice(replacement.end),
      candidate,
    );
};
