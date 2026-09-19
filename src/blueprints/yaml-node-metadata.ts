// ---
// relationships:
//   implements: blueprint-authoring
// ---
import { isDeepStrictEqual } from "node:util";
import {
  CST,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  type Document,
  type Node,
} from "yaml";
import {
  nodesByPath,
  nodeSourceContexts,
  type NodeSourceContext,
} from "./yaml-node-paths.js";
import {
  applySourcePatches,
  parseSource,
  type SourcePatch,
} from "./yaml-source.js";

interface PropertyValue {
  readonly type: "anchor" | "tag";
  readonly source: string;
}

type PropertyToken = CST.SourceToken & { readonly type: "anchor" | "tag" };
function documentDirectives(
  document: Document,
): NonNullable<Document["directives"]> {
  if (!document.directives)
    throw new Error("Cannot preserve YAML metadata without directives");
  return document.directives;
}

export function nodeMetadataSnapshot(document: Document): unknown {
  return [...nodesByPath(document)].map(([path, node]) => ({
    path,
    anchor: isAlias(node) ? undefined : node.anchor,
    tag: node.tag,
  }));
}

function propertyValues(
  document: Document,
  node: Node,
): readonly PropertyValue[] {
  if (isAlias(node)) return [];
  const directives = documentDirectives(document);
  return [
    ...(node.anchor
      ? [{ type: "anchor" as const, source: `&${node.anchor}` }]
      : []),
    ...(node.tag
      ? [{ type: "tag" as const, source: directives.tagString(node.tag) }]
      : []),
  ];
}

function sourcePropertyTokens(
  tokens: readonly CST.SourceToken[],
): readonly PropertyToken[] {
  return tokens.filter(
    (token): token is PropertyToken =>
      token.type === "anchor" || token.type === "tag",
  );
}

function sourceTagUnderDirectives(
  document: Document,
  tokens: readonly CST.SourceToken[],
): string | undefined {
  const tag = sourcePropertyTokens(tokens).find(
    (token) => token.type === "tag",
  );
  if (!tag) return undefined;
  return (
    documentDirectives(document).tagName(tag.source, () => undefined) ??
    undefined
  );
}

function inlineCommentOffset(
  tokens: readonly CST.SourceToken[],
): number | undefined {
  const newline = tokens.find((token) => token.type === "newline");
  return tokens.find(
    (token) =>
      token.type === "comment" &&
      (newline === undefined || token.offset < newline.offset),
  )?.offset;
}

function propertyPatches(
  source: string,
  context: NodeSourceContext,
  desired: readonly PropertyValue[],
  target: Node,
  sourceTag: string | undefined,
): SourcePatch[] {
  const existing = sourcePropertyTokens(context.tokens);
  const desiredByType = new Map(
    desired.map((property) => [property.type, property.source]),
  );
  const changedTypes = new Set<PropertyValue["type"]>();
  if (!isAlias(context.node) && !isAlias(target)) {
    if (context.node.anchor !== target.anchor) changedTypes.add("anchor");
    if (sourceTag !== target.tag) changedTypes.add("tag");
  }
  if (changedTypes.size === 0) return [];

  if (existing.length > 0) {
    const first = existing[0];
    const last = existing.at(-1);
    if (!first || !last) return [];
    const retained = existing.filter((token) => desiredByType.has(token.type));
    if (retained.length === 0) {
      const replacement = desired.map((property) => property.source).join(" ");
      let start = first.offset;
      let end = last.offset + last.source.length;
      const comment = inlineCommentOffset(context.tokens);
      if (comment === undefined)
        while (/[ \t]/u.test(source[end] ?? "")) end += 1;
      if (!replacement && end === last.offset + last.source.length)
        while (start > 0 && /[ \t]/u.test(source[start - 1] ?? "")) start -= 1;
      return [
        {
          start,
          end,
          replacement: replacement ? `${replacement} ` : "",
        },
      ];
    }

    const patches: SourcePatch[] = [];
    for (const token of existing) {
      const replacement = desiredByType.get(token.type);
      if (replacement === undefined) {
        const index = existing.indexOf(token);
        const next = existing[index + 1];
        const previous = existing[index - 1];
        patches.push({
          start: previous
            ? previous.offset + previous.source.length
            : token.offset,
          end: next ? next.offset : token.offset + token.source.length,
          replacement: "",
        });
      } else if (changedTypes.has(token.type)) {
        patches.push({
          start: token.offset,
          end: token.offset + token.source.length,
          replacement,
        });
      }
    }
    const retainedTypes = new Set(retained.map((token) => token.type));
    const additions = desired.filter(
      (property) => !retainedTypes.has(property.type),
    );
    const retainedLast = retained.at(-1);
    if (additions.length > 0 && retainedLast)
      patches.push({
        start: retainedLast.offset + retainedLast.source.length,
        end: retainedLast.offset + retainedLast.source.length,
        replacement: ` ${additions.map((property) => property.source).join(" ")}`,
      });
    return patches;
  }

  const replacement = desired.map((property) => property.source).join(" ");
  if (!replacement || !context.node.range) return [];
  const start = context.node.range[0];
  if (context.root) {
    const block =
      (isMap(context.node) || isSeq(context.node)) &&
      context.node.flow !== true;
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    return [
      {
        start,
        end: start,
        replacement: block ? `${replacement}${newline}` : `${replacement} `,
      },
    ];
  }

  const separatorNewline = context.tokens.find(
    (token) => token.type === "newline",
  );
  const comment = inlineCommentOffset(context.tokens);
  if (comment !== undefined) {
    let start = comment;
    while (start > 0 && /[ \t]/u.test(source[start - 1] ?? "")) start -= 1;
    return [{ start, end: start, replacement: ` ${replacement}` }];
  }
  if (separatorNewline) {
    let patchStart = separatorNewline.offset;
    while (patchStart > 0 && /[ \t]/u.test(source[patchStart - 1] ?? ""))
      patchStart -= 1;
    return [
      {
        start: patchStart,
        end: separatorNewline.offset,
        replacement: ` ${replacement}`,
      },
    ];
  }
  return [{ start, end: start, replacement: `${replacement} ` }];
}

function renderScalarValue(
  document: Document,
  node: Node,
  source: string,
): string {
  const rendered = document.clone();
  const value = node.clone() as Node;
  if (!isAlias(value)) {
    delete value.anchor;
    delete value.tag;
  }
  value.commentBefore = null;
  value.comment = null;
  rendered.contents = value;
  rendered.commentBefore = null;
  rendered.comment = null;
  if (rendered.directives) rendered.directives.docEnd = false;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  return rendered
    .toString({ lineWidth: 0, verifyAliasOrder: false, directives: false })
    .replace(/\n$/u, "")
    .replaceAll("\n", newline);
}

function reconcileTagDependentScalarValues(
  source: string,
  edited: Document,
  tagChanges: ReadonlySet<string>,
): string {
  if (tagChanges.size === 0) return source;
  const current = nodeSourceContexts(source, parseSource(source));
  const expectedDocument = parseSource(edited.toString({ lineWidth: 0 }));
  const expected = nodesByPath(expectedDocument);
  const patches: SourcePatch[] = [];
  for (const path of tagChanges) {
    const context = current.get(path);
    const target = expected.get(path);
    if (
      !context?.node.range ||
      !target ||
      !isScalar(context.node) ||
      !isScalar(target) ||
      isDeepStrictEqual(context.node.value, target.value)
    )
      continue;
    patches.push({
      start: context.node.range[0],
      end: context.node.range[1],
      replacement: renderScalarValue(expectedDocument, target, source),
    });
  }
  return applySourcePatches(source, patches);
}

export function reconcileNodeProperties(
  source: string,
  edited: Document,
): string {
  const current = parseSource(source);
  const contexts = nodeSourceContexts(source, current);
  const desired = nodesByPath(edited);
  const patches: SourcePatch[] = [];
  const tagChanges = new Set<string>();
  for (const [path, context] of contexts) {
    const target = desired.get(path);
    if (!target) continue;
    const sourceTag = sourceTagUnderDirectives(edited, context.tokens);
    if (sourceTag !== target.tag) tagChanges.add(path);
    const nodePatches = propertyPatches(
      source,
      context,
      propertyValues(edited, target),
      target,
      sourceTag,
    );
    patches.push(...nodePatches);
  }
  return reconcileTagDependentScalarValues(
    applySourcePatches(source, patches),
    edited,
    tagChanges,
  );
}
