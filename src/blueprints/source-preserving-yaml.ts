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
import { reconcileComments, commentSnapshot } from "./yaml-comments.js";
import { presentationSnapshot, reconcileSpacing } from "./yaml-presentation.js";

import {
  applySourcePatches,
  parseSource,
  type SourcePatch,
} from "./yaml-source.js";

import {
  shape,
  pairIndex,
  prepareEdit,
  flowNodeStarts,
} from "./yaml-edit-model.js";

function semanticPatches(
  source: string,
  original: Document,
  edited: Document,
): SourcePatch[] {
  const patches: SourcePatch[] = [];
  const flowNodes = flowNodeStarts(original);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lineStart = (offset: number): number =>
    source.lastIndexOf("\n", offset - 1) + 1;

  function render(node: Node, indent: number): string {
    const document = edited.clone();
    document.contents = node.clone() as Node;
    document.commentBefore = null;
    document.comment = null;
    if (document.directives) document.directives.docEnd = false;
    return document
      .toString({ lineWidth: 0, verifyAliasOrder: false, directives: false })
      .replace(/\n$/u, "")
      .replace(/\n(?=[^\n])/gu, `\n${" ".repeat(indent)}`)
      .replaceAll("\n", newline);
  }

  function replace(before: Node, after: Node): void {
    if (!before.range)
      throw new Error("Cannot preserve YAML source for a node without a range");
    let start = before.range[0];
    const end = before.range[1];
    const replacement = after.clone() as Node;
    if (flowNodes.has(start) && (isMap(replacement) || isSeq(replacement)))
      replacement.flow = true;
    if (
      flowNodes.has(start) &&
      isScalar(replacement) &&
      (replacement.type === "BLOCK_LITERAL" ||
        replacement.type === "BLOCK_FOLDED")
    )
      replacement.type = "QUOTE_DOUBLE";
    replacement.commentBefore = null;
    replacement.comment = null;
    if (before.srcToken?.type === "block-scalar")
      replacement.comment = after.comment ?? null;
    // Anchors and tags precede the node's range and remain in the source.
    if (!isAlias(replacement)) {
      delete replacement.anchor;
      delete replacement.tag;
    }
    const block =
      before.srcToken?.type === "block-map" ||
      before.srcToken?.type === "block-seq";
    const indent = block
      ? start - lineStart(start)
      : before.srcToken && "indent" in before.srcToken
        ? before.srcToken.indent
        : 0;
    const newBlock =
      !block && (isMap(replacement) || isSeq(replacement)) && !replacement.flow;
    const sequenceScalar =
      before.srcToken?.type !== "block-scalar" &&
      /^ *- +$/u.test(source.slice(lineStart(start), start));
    let text = render(
      replacement,
      (isScalar(replacement) &&
        (replacement.type === "BLOCK_LITERAL" ||
          replacement.type === "BLOCK_FOLDED" ||
          (typeof replacement.value === "string" &&
            replacement.value.includes("\n")))) ||
        newBlock
        ? indent + (sequenceScalar ? 0 : 2)
        : indent,
    );
    if (newBlock)
      text = `${newline}${" ".repeat(indent + (sequenceScalar ? 0 : 2))}${text}`;
    if (start === end && source[start - 1] === ":") text = ` ${text}`;
    if (start === end && source[end] === "#") text += " ";
    if (source.slice(start, end).endsWith(newline)) text += newline;
    if (text.startsWith(newline))
      while (start > 0 && /[ \t]/u.test(source[start - 1] ?? "")) start -= 1;
    patches.push({ start, end, replacement: text });
  }

  function blockItems(before: Node, after: Node): boolean {
    if (!(isMap(before) && isMap(after)) && !(isSeq(before) && isSeq(after)))
      return false;
    if (
      !before.range ||
      (before.srcToken?.type !== "block-map" &&
        before.srcToken?.type !== "block-seq")
    )
      return false;
    const oldItems = before.items;
    const newItems = after.items;
    if (newItems.length === 0) return false;
    const tokens = before.srcToken.items;
    const indent = before.srcToken.indent;
    const used = new Set<number>();
    const matches = newItems.map((item, index) => {
      let found = -1;
      if (isMap(before)) {
        found = pairIndex(before.items, item as Pair);
      } else if (isNode(item) && item.range) {
        found = oldItems.findIndex(
          (old) => isNode(old) && old.range?.[0] === item.range?.[0],
        );
      } else if (oldItems.length === newItems.length) found = index;
      if (used.has(found)) return -1;
      if (found >= 0) used.add(found);
      return found;
    });
    if (
      matches.every((match, index) => match === index) &&
      oldItems.length === newItems.length
    ) {
      newItems.forEach((item, index) => {
        visitItem(oldItems[index], item);
      });
      return true;
    }
    // Keep the original bytes of every surviving entry, including its trivia.
    const range = before.range;
    const starts = tokens.map((token, index) => {
      const first =
        token.start[0]?.offset ??
        token.key?.offset ??
        token.value?.offset ??
        range[0];
      return index === 0 ? range[0] : lineStart(first);
    });
    const end = before.range[1];
    const pieces = newItems.map((item, index) => {
      const match = matches[index] ?? -1;
      if (match < 0) {
        const collection = after.clone() as typeof after;
        collection.items = [item] as typeof collection.items;
        collection.commentBefore = null;
        collection.comment = null;
        delete collection.anchor;
        delete collection.tag;
        return `${" ".repeat(indent)}${render(collection, indent)}${newline}`;
      }
      const start = starts[match] ?? range[0];
      const stop = starts[match + 1] ?? end;
      const firstPatch = patches.length;
      visitItem(oldItems[match], item);
      const local = patches.splice(firstPatch).map((patch) => ({
        ...patch,
        start: patch.start - start,
        end: patch.end - start,
      }));
      let text = applySourcePatches(source.slice(start, stop), local);
      if (match === 0) text = " ".repeat(indent) + text;
      if (!text.endsWith(newline)) text += newline;
      return text;
    });
    let replacement = pieces.join("").slice(indent);
    if (!source.slice(before.range[0], end).endsWith(newline))
      replacement = replacement.slice(0, -newline.length);
    patches.push({ start: before.range[0], end, replacement });
    return true;
  }

  function visitItem(before: unknown, after: unknown): void {
    if (before && after && !isNode(before) && !isNode(after)) {
      visit((before as Pair).key, (after as Pair).key);
      visit((before as Pair).value, (after as Pair).value);
    } else visit(before, after);
  }

  function visit(before: unknown, after: unknown): void {
    if (isDeepStrictEqual(shape(before), shape(after))) return;
    if (!isNode(before))
      throw new Error("Cannot preserve YAML source for a missing node");
    const target = isNode(after) ? after : edited.createNode(after);
    if (
      (isMap(before) || isSeq(before)) &&
      (isMap(target) || isSeq(target)) &&
      (before.flow === true) !== (target.flow === true)
    ) {
      replace(before, target);
      return;
    }
    if (blockItems(before, target)) return;
    if (
      isMap(before) &&
      isMap(target) &&
      before.items.length === target.items.length &&
      target.items.every(
        (pair, index) => pairIndex(before.items, pair) === index,
      )
    ) {
      before.items.forEach((pair, index) => {
        visitItem(pair, target.items[index]);
      });
    } else if (
      isSeq(before) &&
      isSeq(target) &&
      before.items.length === target.items.length
    ) {
      before.items.forEach((item, index) => {
        visit(item, target.items[index]);
      });
    } else replace(before, target);
  }
  if (original.contents === null && edited.contents !== null) {
    const prefix =
      source.length > 0
        ? source.endsWith(newline)
          ? newline
          : newline + newline
        : "";
    patches.push({
      start: source.length,
      end: source.length,
      replacement: prefix + render(edited.contents, 0) + newline,
    });
  } else visit(original.contents, edited.contents);
  return patches;
}

export function assertPreservedDocument(saved: string, edited: Document): void {
  const reparsed = parseSource(saved);
  const expected = parseSource(edited.toString({ lineWidth: 0 }));
  if (
    reparsed.errors.length ||
    !isDeepStrictEqual(
      reparsed.toJS({ mapAsMap: true }),
      expected.toJS({ mapAsMap: true }),
    ) ||
    !isDeepStrictEqual(commentSnapshot(reparsed), commentSnapshot(expected)) ||
    !isDeepStrictEqual(
      presentationSnapshot(reparsed),
      presentationSnapshot(expected),
    )
  ) {
    throw new Error("Localized YAML edit did not preserve the edited document");
  }
}

export function saveLocalizedYaml(
  source: string,
  formattedSource: string,
  edited: Document,
): string {
  if (edited.toString() === formattedSource) return source;
  const original = parseSource(source);
  const intended = prepareEdit(original, edited);
  const values = applySourcePatches(
    source,
    semanticPatches(source, original, intended),
  );
  const saved = reconcileSpacing(reconcileComments(values, intended), intended);
  assertPreservedDocument(saved, intended);
  return saved;
}
