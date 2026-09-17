// ---
// relationships:
//   implements: blueprint-authoring
// ---
import { isMap, isNode, isSeq, Parser, type Document, type Node } from "yaml";
import {
  applySourcePatches,
  parseSource,
  type SourcePatch,
} from "./yaml-source.js";

interface CommentSlot {
  readonly path: string;
  readonly value: string;
  readonly before: boolean;
  readonly node?: Node;
}

export function slots(document: Document): CommentSlot[] {
  const result: CommentSlot[] = [];
  function add(
    path: string,
    value: string | null | undefined,
    before: boolean,
    node?: Node,
  ): void {
    result.push({
      path,
      value: (value ?? "").replaceAll("\r\n", "\n"),
      before,
      ...(node ? { node } : {}),
    });
  }
  function visit(node: unknown, path: string): void {
    if (!isNode(node)) return;
    add(`${path}.before`, node.commentBefore, true, node);
    if (isMap(node))
      node.items.forEach((pair, index) => {
        visit(pair.key, `${path}.${String(index)}.key`);
        visit(pair.value, `${path}.${String(index)}.value`);
      });
    else if (isSeq(node))
      node.items.forEach((item, index) => {
        visit(item, `${path}.${String(index)}`);
      });
    add(`${path}.after`, node.comment, false, node);
  }
  add("document.before", document.commentBefore, true);
  visit(document.contents, "root");
  add("document.after", document.comment, false);
  return result;
}

export function commentSnapshot(document: Document): unknown {
  return slots(document)
    .filter((slot) => slot.value)
    .map((slot) => [slot.path, slot.value]);
}

interface CommentToken {
  readonly offset: number;
  readonly source: string;
}

export function commentTokens(source: string): CommentToken[] {
  const result: CommentToken[] = [];
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record["type"] === "comment") result.push(value as CommentToken);
    else Object.values(record).forEach(visit);
  }
  for (const token of new Parser().parse(source)) visit(token);
  return result.sort((a, b) => a.offset - b.offset);
}

export function reconcileComments(source: string, edited: Document): string {
  const original = parseSource(source);
  const expected = parseSource(edited.toString({ lineWidth: 0 }));
  const desired = new Map(
    slots(expected).map((slot) => [slot.path, slot.value]),
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
    const owned = tokens.slice(cursor, cursor + count);
    cursor += count;
    const value = desired.get(slot.path) ?? "";
    if (value === slot.value) continue;
    const nodeStart = slot.node?.range?.[0] ?? 0;
    let indent =
      /^ */u.exec(source.slice(lineStart(nodeStart), nodeStart))?.[0] ?? "";
    const inlineValue =
      slot.before &&
      slot.path.endsWith(".value.before") &&
      source.slice(lineStart(nodeStart), nodeStart).trim().length > 0;
    if (inlineValue)
      indent = " ".repeat(
        slot.node?.srcToken && "indent" in slot.node.srcToken
          ? slot.node.srcToken.indent + 2
          : indent.length + 2,
      );
    if (
      !slot.before &&
      slot.node &&
      slot.node.srcToken?.type !== "block-map" &&
      slot.node.srcToken?.type !== "block-seq"
    )
      indent += "  ";
    const text = value
      .replace(/^(?!$)(?: $)?/gmu, "#")
      .replaceAll("\n", `${newline}${indent}`);
    const first = owned[0];
    const last = owned.at(-1);
    if (first && last) {
      let start = first.offset;
      let end = last.offset + last.source.length;
      if (!value && slot.before) {
        start = lineStart(start);
        if (source.slice(end, end + newline.length) === newline)
          end += newline.length;
        if (!slot.node && source.slice(end, end + newline.length) === newline)
          end += newline.length;
      }
      if (!value && !slot.before)
        while (
          start > lineStart(start) &&
          /[ \t]/u.test(source[start - 1] ?? "")
        )
          start -= 1;
      patches.push({ start, end, replacement: text });
    } else if (value) {
      if (slot.before) {
        let start = inlineValue
          ? nodeStart
          : slot.node
            ? lineStart(nodeStart)
            : 0;
        const end = start;
        if (inlineValue)
          while (
            start > lineStart(start) &&
            /[ \t]/u.test(source[start - 1] ?? "")
          )
            start -= 1;
        patches.push({
          start,
          end,
          replacement: inlineValue
            ? `${newline}${indent}${text}${newline}${indent}`
            : `${indent}${text}${newline}${slot.node ? "" : newline}`,
        });
      } else {
        const header =
          slot.node?.srcToken?.type === "block-scalar"
            ? slot.node.srcToken.props[0]
            : undefined;
        const end =
          header && "source" in header
            ? header.offset + header.source.length
            : (slot.node?.range?.[1] ?? source.length);
        const terminated = source.slice(0, end).endsWith(newline);
        if (/^[ \t]*[}\]]/u.test(source.slice(end))) {
          patches.push({ start: end, end, replacement: ` ${text}${newline}` });
          continue;
        }
        if (source[end] === ",") {
          let stop = end + 1;
          while (/[ \t]/u.test(source[stop] ?? "")) stop += 1;
          const hasNewline =
            source.slice(stop, stop + newline.length) === newline;
          patches.push({
            start: end,
            end: stop,
            replacement: `, ${text}${hasNewline ? "" : newline + indent}`,
          });
          continue;
        }
        patches.push({
          start: end,
          end,
          replacement: `${terminated ? indent : " "}${text}${terminated ? newline : ""}`,
        });
      }
    }
  }
  if (cursor !== tokens.length)
    throw new Error("Cannot associate every YAML comment with its source node");
  return applySourcePatches(source, patches);
}
