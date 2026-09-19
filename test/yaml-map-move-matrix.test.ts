// ---
// relationships:
//   verifies: blueprint-authoring
// ---
import { describe, expect, it } from "vitest";
import {
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  type Document,
  type Pair,
  type YAMLMap,
} from "yaml";
import { saveLocalizedYaml } from "../src/blueprints/source-preserving-yaml.js";

type Path = readonly (string | number)[];

function mapAt(document: Document, path: Path): YAMLMap {
  const value = document.getIn(path, true);
  if (!isMap(value)) throw new Error(`Missing map at ${path.join(".")}`);
  return value;
}

function movePair(document: Document, from: Path, to: Path): Pair {
  const [pair] = mapAt(document, from).items.splice(1, 1);
  if (!pair) throw new Error("Missing pair to move");
  mapAt(document, to).items.push(pair);
  return pair;
}

const contexts = [
  {
    name: "equal depth",
    source:
      "a:\n  keep: 0\n  x: [1, 2]   # old\nb:\n  y: 1\ntail: 9   # untouched\n",
    from: ["a"] as Path,
    to: ["b"] as Path,
    indent: "  ",
  },
  {
    name: "deeper",
    source:
      "a:\n  keep: 0\n  x: [1, 2]   # old\nb:\n  nested:\n    y: 1\ntail: 9   # untouched\n",
    from: ["a"] as Path,
    to: ["b", "nested"] as Path,
    indent: "    ",
  },
  {
    name: "shallower",
    source:
      "a:\n  nested:\n    keep: 0\n    x: [1, 2]   # old\nb:\n  y: 1\ntail: 9   # untouched\n",
    from: ["a", "nested"] as Path,
    to: ["b"] as Path,
    indent: "  ",
  },
  {
    name: "maps in sequences",
    source:
      "items:\n  - a:\n      keep: 0\n      x: [1, 2]   # old\n  - b:\n      y: 1\ntail: 9   # untouched\n",
    from: ["items", 0, "a"] as Path,
    to: ["items", 1, "b"] as Path,
    indent: "      ",
  },
];

const edits: {
  name: string;
  apply: (pair: Pair) => void;
  expected: string;
}[] = [
  { name: "none", apply: () => undefined, expected: "x: [1, 2]   # old" },
  {
    name: "key",
    apply: (pair) => {
      if (!isScalar(pair.key)) throw new Error("Missing scalar key");
      pair.key.value = "next";
    },
    expected: "next: [1, 2]   # old",
  },
  {
    name: "value",
    apply: (pair) => {
      if (!isSeq(pair.value) || !isScalar(pair.value.items[1]))
        throw new Error("Missing sequence value");
      pair.value.items[1].value = 3;
    },
    expected: "x: [1, 3]   # old",
  },
  {
    name: "trailing comment",
    apply: (pair) => {
      if (!isNode(pair.value)) throw new Error("Missing value node");
      pair.value.comment = " changed";
    },
    expected: "x: [1, 2]   # changed",
  },
  {
    name: "commentBefore and spacing",
    apply: (pair) => {
      if (!isNode(pair.key)) throw new Error("Missing key node");
      pair.key.commentBefore = " added";
      pair.key.spaceBefore = true;
    },
    expected: "# added",
  },
  {
    name: "flow presentation",
    apply: (pair) => {
      if (!isSeq(pair.value)) throw new Error("Missing sequence value");
      pair.value.flow = false;
    },
    expected: "x:",
  },
];

describe("YAML map move source-context and edit matrix", () => {
  for (const context of contexts)
    for (const edit of edits)
      it(`${context.name}: moved pair with ${edit.name} edit`, () => {
        const document = parseDocument(context.source, {
          keepSourceTokens: true,
        });
        const pair = movePair(document, context.from, context.to);
        edit.apply(pair);
        if (!isScalar(pair.key)) throw new Error("Missing scalar key");
        const key = pair.key.value;
        const expectedValue = JSON.stringify(pair.value);
        const saved = saveLocalizedYaml(context.source, document);
        expect(saved).toContain(`${context.indent}${edit.expected}`);
        expect(saved).toContain("tail: 9   # untouched\n");
        expect(saved).not.toMatch(/[ \t]+\r?$/mu);
        const parsed = parseDocument(saved);
        expect(parsed.errors).toEqual([]);
        const actualValue = parsed.getIn([...context.to, key], true);
        expect(JSON.stringify(actualValue)).toBe(expectedValue);
        expect(mapAt(parsed, context.from).has("x")).toBe(false);
      });
});
