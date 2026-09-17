// ---
// relationships:
//   implements: blueprint-authoring
// ---
import {
  CST,
  isMap,
  isNode,
  isSeq,
  Parser,
  type Document,
  type Node,
} from "yaml";

export interface NodeSourceContext {
  readonly node: Node;
  readonly tokens: readonly CST.SourceToken[];
  readonly root: boolean;
}

function parsedDocumentToken(source: string): CST.Document {
  const token = [...new Parser().parse(source)].find(
    (candidate): candidate is CST.Document => candidate.type === "document",
  );
  if (!token)
    throw new Error("Cannot preserve YAML metadata without a document");
  return token;
}

export function nodeSourceContexts(
  source: string,
  document: Document,
): Map<string, NodeSourceContext> {
  const result = new Map<string, NodeSourceContext>();

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

export function nodesByPath(document: Document): Map<string, Node> {
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
