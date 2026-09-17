// ---
// relationships:
//   implements: blueprint-authoring
// ---
import { isAlias, isMap, isScalar, isSeq, type Document } from "yaml";
import { slots, commentTokens } from "./yaml-comments.js";
import {
  applySourcePatches,
  parseSource,
  type SourcePatch,
} from "./yaml-source.js";

export function presentationSnapshot(document: Document): unknown {
  return {
    directives: document.directives,
    nodes: slots(document)
      .filter((slot) => slot.before && slot.node)
      .map(({ path, node }) => ({
        path,
        spaceBefore: node?.spaceBefore === true,
        type: isScalar(node) ? node.type : undefined,
        format: isScalar(node) ? node.format : undefined,
        minFractionDigits: isScalar(node) ? node.minFractionDigits : undefined,
        flow: isMap(node) || isSeq(node) ? node.flow === true : undefined,
        anchor: node && !isAlias(node) ? node.anchor : undefined,
        tag: node?.tag,
      })),
  };
}

export function reconcileSpacing(source: string, edited: Document): string {
  const original = parseSource(source);
  const expected = parseSource(edited.toString({ lineWidth: 0 }));
  const desired = new Map(
    slots(expected)
      .filter((slot) => slot.before)
      .map((slot) => [slot.path, slot.node?.spaceBefore === true]),
  );
  const tokens = commentTokens(source);
  const patches: SourcePatch[] = [];
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lineStart = (offset: number): number =>
    source.lastIndexOf("\n", offset - 1) + 1;
  let cursor = 0;
  for (const slot of slots(original)) {
    const count = slot.value
      .split("\n")
      .filter((line) => line.length > 0).length;
    const first = tokens[cursor];
    cursor += count;
    if (
      !slot.before ||
      !slot.node ||
      (slot.node.spaceBefore === true) === desired.get(slot.path)
    )
      continue;
    const offset = count > 0 && first ? first.offset : slot.node.range?.[0];
    if (offset === undefined) continue;
    const end = lineStart(offset);
    let start = end;
    if (!desired.get(slot.path)) {
      while (start > 0) {
        const previous = lineStart(start - newline.length);
        if (source.slice(previous, start).trim()) break;
        start = previous;
      }
    }
    patches.push({
      start,
      end,
      replacement: desired.get(slot.path) ? newline : "",
    });
  }
  return applySourcePatches(source, patches);
}
