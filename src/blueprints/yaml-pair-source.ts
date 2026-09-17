// ---
// relationships:
//   implements: blueprint-authoring
// ---
import { isMap, isNode, isSeq, type Document, type Pair } from "yaml";
import { applySourcePatches, type SourcePatch } from "./yaml-source.js";

export interface RetainedPairSource {
  readonly pair: Pair;
  render(patches: readonly SourcePatch[], destinationIndent: number): string;
}

interface PairSource {
  readonly pair: Pair;
  readonly start: number;
  readonly end: number;
  readonly indent: number;
  readonly first: boolean;
}

function pairIdentity(pair: Pair): number | undefined {
  return (
    pair.srcToken?.key?.offset ??
    pair.srcToken?.value?.offset ??
    (isNode(pair.key) ? pair.key.range?.[0] : undefined) ??
    (isNode(pair.value) ? pair.value.range?.[0] : undefined)
  );
}

function preparedPairIdentities(
  authored: Document,
  prepared: Document,
): WeakMap<Pair, number> {
  const identities = new WeakMap<Pair, number>();
  function visit(before: unknown, after: unknown): void {
    if (isMap(before) && isMap(after)) {
      before.items.forEach((pair, index) => {
        const target = after.items[index];
        if (!target) return;
        const identity = pairIdentity(pair);
        if (identity !== undefined) identities.set(target, identity);
        visit(pair.key, target.key);
        visit(pair.value, target.value);
      });
    } else if (isSeq(before) && isSeq(after)) {
      before.items.forEach((item, index) => {
        visit(item, after.items[index]);
      });
    }
  }
  visit(authored.contents, prepared.contents);
  return identities;
}

function sourcePairs(
  source: string,
  document: Document,
): Map<number, PairSource> {
  const result = new Map<number, PairSource>();
  const lineStart = (offset: number): number =>
    source.lastIndexOf("\n", offset - 1) + 1;
  function visit(value: unknown): void {
    if (isMap(value)) {
      if (
        value.range &&
        value.srcToken?.type === "block-map" &&
        value.items.length === value.srcToken.items.length
      ) {
        const sourceIndent = value.srcToken.indent;
        const starts = value.srcToken.items.map((token, index) => {
          const first =
            token.start[0]?.offset ??
            token.key?.offset ??
            token.value?.offset ??
            value.range?.[0] ??
            0;
          return index === 0 ? (value.range?.[0] ?? first) : lineStart(first);
        });
        value.items.forEach((pair, index) => {
          const identity = pairIdentity(pair);
          const start = starts[index];
          if (identity === undefined || start === undefined) return;
          result.set(identity, {
            pair,
            start,
            end: starts[index + 1] ?? value.range?.[1] ?? start,
            indent: sourceIndent,
            first: index === 0,
          });
        });
      }
      value.items.forEach((pair) => {
        visit(pair.key);
        visit(pair.value);
      });
    } else if (isSeq(value)) value.items.forEach(visit);
  }
  visit(document.contents);
  return result;
}

function reindent(
  text: string,
  sourceIndent: number,
  destinationIndent: number,
  newline: string,
): string {
  if (sourceIndent === destinationIndent) return text;
  const delta = destinationIndent - sourceIndent;
  return text
    .split(newline)
    .map((line) => {
      if (/^[ \t]*$/u.test(line)) return "";
      if (delta > 0) return `${" ".repeat(delta)}${line}`;
      const available = /^ */u.exec(line)?.[0].length ?? 0;
      return line.slice(Math.min(-delta, available));
    })
    .join(newline);
}

export function retainedPairSources(
  source: string,
  original: Document,
  authored: Document,
  prepared: Document,
): WeakMap<Pair, RetainedPairSource> {
  const identities = preparedPairIdentities(authored, prepared);
  const identityOf = (pair: Pair): number | undefined =>
    identities.get(pair) ?? pairIdentity(pair);
  const pairs = sourcePairs(source, original);
  const occurrences = new Map<number, number>();
  const preparedPairs: Pair[] = [];
  function visit(value: unknown): void {
    if (isMap(value)) {
      value.items.forEach((pair) => {
        preparedPairs.push(pair);
        const identity = identityOf(pair);
        if (identity !== undefined)
          occurrences.set(identity, (occurrences.get(identity) ?? 0) + 1);
        visit(pair.key);
        visit(pair.value);
      });
    } else if (isSeq(value)) value.items.forEach(visit);
  }
  visit(prepared.contents);

  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const result = new WeakMap<Pair, RetainedPairSource>();
  for (const pair of preparedPairs) {
    const identity = identityOf(pair);
    if (identity === undefined || occurrences.get(identity) !== 1) continue;
    const retained = pairs.get(identity);
    if (!retained) continue;
    result.set(pair, {
      pair: retained.pair,
      render: (patches, destinationIndent) => {
        const local = patches.map((patch) => ({
          ...patch,
          start: patch.start - retained.start,
          end: patch.end - retained.start,
        }));
        let text = applySourcePatches(
          source.slice(retained.start, retained.end),
          local,
        );
        if (retained.first) text = " ".repeat(retained.indent) + text;
        return reindent(text, retained.indent, destinationIndent, newline);
      },
    });
  }
  return result;
}
