// ---
// relationships:
//   implements: blueprint-authoring
// ---
import {
  CST,
  isAlias,
  isMap,
  isNode,
  isSeq,
  Parser,
  type Document,
  type Node,
} from "yaml";
import {
  applySourcePatches,
  parseSource,
  type SourcePatch,
} from "./yaml-source.js";

interface PropertyContext {
  readonly node: Node;
  readonly tokens: readonly CST.SourceToken[];
  readonly root: boolean;
}

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

function parsedDocumentToken(source: string): CST.Document {
  const token = [...new Parser().parse(source)].find(
    (candidate): candidate is CST.Document => candidate.type === "document",
  );
  if (!token)
    throw new Error("Cannot preserve YAML metadata without a document");
  return token;
}

function propertyContexts(
  source: string,
  document: Document,
): Map<string, PropertyContext> {
  const result = new Map<string, PropertyContext>();

  function visit(
    value: unknown,
    path: string,
    tokens: readonly CST.SourceToken[],
    root = false,
  ): void {
    if (!isNode(value)) return;
    result.set(path, { node: value, tokens, root });
    if (isMap(value))
      value.items.forEach((pair, index) => {
        visit(
          pair.key,
          `${path}.${String(index)}.key`,
          pair.srcToken?.start ?? [],
        );
        visit(
          pair.value,
          `${path}.${String(index)}.value`,
          pair.srcToken?.sep ?? [],
        );
      });
    if (isSeq(value))
      value.items.forEach((item, index) => {
        const token =
          value.srcToken && "items" in value.srcToken
            ? value.srcToken.items[index]
            : undefined;
        visit(item, `${path}.${String(index)}`, token?.start ?? []);
      });
  }

  visit(document.contents, "root", parsedDocumentToken(source).start, true);
  return result;
}

function nodesByPath(document: Document): Map<string, Node> {
  const result = new Map<string, Node>();
  function visit(value: unknown, path: string): void {
    if (!isNode(value)) return;
    result.set(path, value);
    if (isMap(value))
      value.items.forEach((pair, index) => {
        visit(pair.key, `${path}.${String(index)}.key`);
        visit(pair.value, `${path}.${String(index)}.value`);
      });
    if (isSeq(value))
      value.items.forEach((item, index) => {
        visit(item, `${path}.${String(index)}`);
      });
  }
  visit(document.contents, "root");
  return result;
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

function propertyPatch(
  source: string,
  context: PropertyContext,
  desired: readonly PropertyValue[],
): SourcePatch | undefined {
  const existing = sourcePropertyTokens(context.tokens);
  const desiredByType = new Map(
    desired.map((property) => [property.type, property.source]),
  );
  if (
    existing.length === desired.length &&
    existing.every((token) => token.source === desiredByType.get(token.type))
  )
    return undefined;

  const retainedTypes = new Set(existing.map((token) => token.type));
  const ordered = [
    ...existing.flatMap((token) => {
      const value = desiredByType.get(token.type);
      return value ? [value] : [];
    }),
    ...desired
      .filter((property) => !retainedTypes.has(property.type))
      .map((property) => property.source),
  ];
  const replacement = ordered.join(" ");
  if (existing.length > 0) {
    const first = existing[0];
    const last = existing.at(-1);
    if (!first || !last) return undefined;
    let start = first.offset;
    let end = last.offset + last.source.length;
    while (/[ \t]/u.test(source[end] ?? "")) end += 1;
    if (!replacement && end === last.offset + last.source.length)
      while (start > 0 && /[ \t]/u.test(source[start - 1] ?? "")) start -= 1;
    const sameLine = !source.slice(end, context.node.range?.[0]).includes("\n");
    return {
      start,
      end,
      replacement: replacement && sameLine ? `${replacement} ` : replacement,
    };
  }

  if (!replacement || !context.node.range) return undefined;
  const start = context.node.range[0];
  if (context.root) {
    const block =
      (isMap(context.node) || isSeq(context.node)) &&
      context.node.flow !== true;
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    return {
      start,
      end: start,
      replacement: block ? `${replacement}${newline}` : `${replacement} `,
    };
  }

  const separatorNewline = [...context.tokens]
    .reverse()
    .find((token) => token.type === "newline");
  if (separatorNewline) {
    let patchStart = separatorNewline.offset;
    while (patchStart > 0 && /[ \t]/u.test(source[patchStart - 1] ?? ""))
      patchStart -= 1;
    return {
      start: patchStart,
      end: separatorNewline.offset,
      replacement: ` ${replacement}`,
    };
  }
  return { start, end: start, replacement: `${replacement} ` };
}

export function reconcileNodeProperties(
  source: string,
  edited: Document,
): string {
  const current = parseSource(source);
  const contexts = propertyContexts(source, current);
  const desired = nodesByPath(edited);
  const patches: SourcePatch[] = [];
  for (const [path, context] of contexts) {
    const target = desired.get(path);
    if (!target) continue;
    const patch = propertyPatch(
      source,
      context,
      propertyValues(edited, target),
    );
    if (patch) patches.push(patch);
  }
  return applySourcePatches(source, patches);
}
