// ---
// relationships:
//   implements: blueprint-authoring
// ---
import { isDeepStrictEqual } from "node:util";
import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  type Document,
  type Node,
  type Pair,
} from "yaml";

export function shape(value: unknown): unknown {
  if (isAlias(value)) return { alias: value.source };
  if (isScalar(value))
    return {
      value: value.value,
      type: value.type,
      format: value.format,
      minFractionDigits: value.minFractionDigits,
    };
  if (isMap(value))
    return {
      map: value.items.map((pair) => [shape(pair.key), shape(pair.value)]),
      flow: value.flow === true,
    };
  if (isSeq(value))
    return { sequence: value.items.map(shape), flow: value.flow === true };
  return value;
}

export function pairIndex(items: readonly Pair[], pair: Pair): number {
  const keyStart = isNode(pair.key) ? pair.key.range?.[0] : undefined;
  const valueStart = isNode(pair.value) ? pair.value.range?.[0] : undefined;
  const retained = items.findIndex(
    (old) =>
      (keyStart !== undefined &&
        isNode(old.key) &&
        old.key.range?.[0] === keyStart) ||
      (valueStart !== undefined &&
        isNode(old.value) &&
        old.value.range?.[0] === valueStart),
  );
  return retained >= 0
    ? retained
    : items.findIndex((old) =>
        isDeepStrictEqual(
          isScalar(old.key) ? old.key.value : shape(old.key),
          isScalar(pair.key) ? pair.key.value : shape(pair.key),
        ),
      );
}

// Plain JS replacements have no presentation metadata. Inherit source style;
// explicitly assigned Document metadata always wins.
export function prepareEdit(original: Document, edited: Document): Document {
  const result = edited.clone();
  // yaml's Document clone clears the document-end marker.
  if (!result.directives || !edited.directives)
    throw new Error("Cannot preserve YAML edits without document directives");
  result.directives.docEnd = edited.directives.docEnd;
  function visit(before: unknown, value: unknown): Node {
    const after = isNode(value) ? value : result.createNode(value);
    if (
      !isNode(value) &&
      isScalar(before) &&
      isScalar(after) &&
      after.type === undefined &&
      before.type !== undefined
    )
      after.type = before.type;
    if (
      !isNode(value) &&
      (isMap(before) || isSeq(before)) &&
      (isMap(after) || isSeq(after)) &&
      after.flow === undefined &&
      before.flow !== undefined
    )
      after.flow = before.flow;
    if (isMap(after))
      after.items.forEach((pair) => {
        const old = isMap(before)
          ? before.items[pairIndex(before.items, pair)]
          : undefined;
        pair.key = visit(old?.key, pair.key);
        pair.value = visit(old?.value, pair.value);
      });
    if (isSeq(after))
      after.items = after.items.map((item, index) =>
        visit(isSeq(before) ? before.items[index] : undefined, item),
      );
    return after;
  }
  if (result.contents !== null)
    result.contents = visit(original.contents, result.contents);
  return result;
}

export function flowNodeStarts(document: Document): Set<number> {
  const starts = new Set<number>();
  function visit(value: unknown, flow: boolean): void {
    if (!isNode(value)) return;
    if (flow && value.range) starts.add(value.range[0]);
    if (isMap(value))
      value.items.forEach((pair) => {
        visit(pair.key, flow || value.flow === true);
        visit(pair.value, flow || value.flow === true);
      });
    if (isSeq(value))
      value.items.forEach((item) => {
        visit(item, flow || value.flow === true);
      });
  }
  visit(document.contents, false);
  return starts;
}
