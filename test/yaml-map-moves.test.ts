// ---
// relationships:
//   verifies: blueprint-authoring
// ---
import { describe, expect, it } from "vitest";
import {
  Pair,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  type Document,
  type YAMLMap,
} from "yaml";
import { saveLocalizedYaml } from "../src/blueprints/source-preserving-yaml.js";

type Path = readonly (string | number)[];

function mapAt(document: Document, path: Path): YAMLMap {
  const value =
    path.length > 0 ? document.getIn(path, true) : document.contents;
  if (!isMap(value)) throw new Error(`Missing map at ${path.join(".")}`);
  return value;
}

function movePair(
  document: Document,
  from: Path,
  to: Path,
  index: number,
): Pair {
  const source = mapAt(document, from);
  const destination = mapAt(document, to);
  const [pair] = source.items.splice(index, 1);
  if (!pair) throw new Error("Missing pair to move");
  destination.items.push(pair);
  return pair;
}

function write(source: string, edit: (document: Document) => void): string {
  const document = parseDocument(source, { keepSourceTokens: true });
  edit(document);
  return saveLocalizedYaml(source, document);
}

describe("YAML map pair source moves", () => {
  it("keeps the recorded equal-depth pair bytes", () => {
    const source = "a:\n  x: [1, 2]   # k\nb:\n  y: 1\n";
    expect(
      write(source, (document) => {
        movePair(document, ["a"], ["b"], 0);
      }),
    ).toBe("a:\n  {}\nb:\n  y: 1\n  x: [1, 2]   # k\n");
  });

  it("adds only the indentation required by a deeper destination", () => {
    const source =
      "a:\n  keep: 0\n  x: [1, 2]   # k\nb:\n  nested:\n    y: 1\ntail: 9   # untouched\n";
    expect(
      write(source, (document) => {
        movePair(document, ["a"], ["b", "nested"], 1);
      }),
    ).toBe(
      "a:\n  keep: 0\nb:\n  nested:\n    y: 1\n    x: [1, 2]   # k\ntail: 9   # untouched\n",
    );
  });

  it("removes only the indentation required by a shallower destination", () => {
    const source =
      "a:\n  nested:\n    keep: 0\n    x: [1, 2]   # k\nb:\n  y: 1\ntail: 9   # untouched\n";
    expect(
      write(source, (document) => {
        movePair(document, ["a", "nested"], ["b"], 1);
      }),
    ).toBe(
      "a:\n  nested:\n    keep: 0\nb:\n  y: 1\n  x: [1, 2]   # k\ntail: 9   # untouched\n",
    );
  });

  it("moves attached leading and trailing comments with the pair", () => {
    const source =
      "a:\n  keep: 0\n\n  # before x\n  x: [1, 2]   # after x\nb:\n  y: 1\n";
    expect(
      write(source, (document) => {
        movePair(document, ["a"], ["b"], 1);
      }),
    ).toBe(
      "a:\n  keep: 0\nb:\n  y: 1\n\n  # before x\n  x: [1, 2]   # after x\n",
    );
  });

  it.each([
    ["literal", "|+ # keep", "    first\n\n", "first\n\n"],
    ["folded", ">- # keep", "    first\n    second\n", "first second"],
  ])("retains a moved %s block scalar", (_name, header, body, value) => {
    const source = `a:\n  keep: 0\n  x: ${header}\n${body}b:\n  y: 1\n`;
    const saved = write(source, (document) => {
      movePair(document, ["a"], ["b"], 1);
    });
    expect(saved).toBe(`a:\n  keep: 0\nb:\n  y: 1\n  x: ${header}\n${body}`);
    expect(parseDocument(saved).getIn(["b", "x"])).toBe(value);
  });

  it.each([
    [
      "literal deeper",
      "a:\n  keep: 0\n  x: |- # keep\n    first\n    second\nb:\n  nested:\n    y: 1\n",
      ["a"],
      ["b", "nested"],
      "a:\n  keep: 0\nb:\n  nested:\n    y: 1\n    x: |- # keep\n      first\n      second\n",
    ],
    [
      "folded deeper",
      "a:\n  keep: 0\n  x: >- # keep\n    first\n    second\nb:\n  nested:\n    y: 1\n",
      ["a"],
      ["b", "nested"],
      "a:\n  keep: 0\nb:\n  nested:\n    y: 1\n    x: >- # keep\n      first\n      second\n",
    ],
    [
      "literal shallower",
      "a:\n  nested:\n    keep: 0\n    x: |- # keep\n      first\n      second\nb:\n  y: 1\n",
      ["a", "nested"],
      ["b"],
      "a:\n  nested:\n    keep: 0\nb:\n  y: 1\n  x: |- # keep\n    first\n    second\n",
    ],
    [
      "folded shallower",
      "a:\n  nested:\n    keep: 0\n    x: >- # keep\n      first\n      second\nb:\n  y: 1\n",
      ["a", "nested"],
      ["b"],
      "a:\n  nested:\n    keep: 0\nb:\n  y: 1\n  x: >- # keep\n    first\n    second\n",
    ],
  ] as const)(
    "retains %s block scalar bytes",
    (_name, source, from, to, expected) => {
      expect(
        write(source, (document) => {
          movePair(document, from, to, 1);
        }),
      ).toBe(expected);
    },
  );

  it("retains non-string keys and aliases", () => {
    const source =
      "base: &keep value\na:\n  keep: 0\n  7: *keep   # alias\nb:\n  y: 1\n";
    const saved = write(source, (document) => {
      movePair(document, ["a"], ["b"], 1);
    });
    expect(saved).toBe(
      "base: &keep value\na:\n  keep: 0\nb:\n  y: 1\n  7: *keep   # alias\n",
    );
    expect(parseDocument(saved).toJS()).toMatchObject({ b: { 7: "value" } });
  });

  it("does not treat a copied pair as moved source identity", () => {
    const source = "a:\n  x: [1, 2]   # original\nb:\n  y: 1\n";
    expect(
      write(source, (document) => {
        const original = mapAt(document, ["a"]).items[0];
        if (!original || !isNode(original.key) || !isNode(original.value))
          throw new Error("Missing source pair");
        mapAt(document, ["b"]).items.push(
          new Pair(original.key.clone(), original.value.clone()),
        );
      }),
    ).toBe(
      "a:\n  x: [1, 2]   # original\nb:\n  y: 1\n  x: [ 1, 2 ] # original\n",
    );
  });

  it("uses moved identity when it replaces the same key in another map", () => {
    const source =
      "a:\n  x: [1, 2]   # moved\nb:\n  x: [3, 4] # replaced\ntail: 9\n";
    expect(
      write(source, (document) => {
        const sourceMap = mapAt(document, ["a"]);
        const destination = mapAt(document, ["b"]);
        const [pair] = sourceMap.items.splice(0, 1);
        if (!pair) throw new Error("Missing pair to move");
        destination.items[0] = pair;
      }),
    ).toBe("a:\n  {}\nb:\n  x: [1, 2]   # moved\ntail: 9\n");
  });

  it("applies replacements of both moved pair nodes after source reuse", () => {
    const source = "a:\n  x: [1, 2]   # old\nb:\n  y: 1\n";
    const saved = write(source, (document) => {
      const pair = movePair(document, ["a"], ["b"], 0);
      pair.key = document.createNode("next");
      pair.value = document.createNode([3, 4]);
    });
    expect(saved).not.toContain("x: [1, 2]");
    expect(parseDocument(saved).toJS()).toEqual({
      a: {},
      b: { y: 1, next: [3, 4] },
    });
  });

  it("applies key, value, comment, presentation and metadata edits after a move", () => {
    const source =
      "a:\n  keep: 0\n  x: &old [1, 2]   # old\nb:\n  y: 1\nuse: *old\n";
    const saved = write(source, (document) => {
      const pair = movePair(document, ["a"], ["b"], 1);
      if (!isScalar(pair.key) || !isSeq(pair.value))
        throw new Error("Missing moved pair");
      pair.key.value = "next";
      pair.key.commentBefore = " added";
      pair.key.spaceBefore = true;
      pair.value.anchor = "new";
      pair.value.tag = "tag:yaml.org,2002:seq";
      pair.value.flow = false;
      const item = pair.value.items[1];
      if (!isScalar(item)) throw new Error("Missing moved value");
      item.value = 3;
      pair.value.comment = " changed";
      const alias = document.get("use", true);
      if (!isAlias(alias)) throw new Error("Missing alias");
      alias.source = "new";
    });
    expect(saved).not.toContain("x: &old [1, 2]");
    expect(saved).not.toMatch(/[ \t]+\r?$/mu);
    const parsed = parseDocument(saved);
    expect(parsed.errors).toEqual([]);
    const destination = mapAt(parsed, ["b"]);
    const pair = destination.items[1];
    if (!pair || !isScalar(pair.key) || !isSeq(pair.value))
      throw new Error("Missing saved pair");
    expect(pair.key.value).toBe("next");
    expect(pair.key.commentBefore).toBe(" added");
    expect(pair.key.spaceBefore).toBe(true);
    expect(
      pair.value.items.map((item) => (isScalar(item) ? item.value : null)),
    ).toEqual([1, 3]);
    expect(pair.value.flow).not.toBe(true);
    expect(pair.value.anchor).toBe("new");
    expect(pair.value.tag).toBe("tag:yaml.org,2002:seq");
    expect(pair.value.comment).toBe(" changed");
    const alias = parsed.get("use", true);
    expect(isAlias(alias) ? alias.source : undefined).toBe("new");
  });

  it.each([
    ["LF terminated", "\n", true],
    ["LF unterminated", "\n", false],
    ["CRLF terminated", "\r\n", true],
    ["CRLF unterminated", "\r\n", false],
  ])("retains moved bytes with %s input", (_name, newline, terminated) => {
    const lines = ["a:", "  keep: 0", "  x: [1, 2]   # k", "b:", "  y: 1"];
    const source = lines.join(newline) + (terminated ? newline : "");
    const expected =
      ["a:", "  keep: 0", "b:", "  y: 1", "  x: [1, 2]   # k"].join(newline) +
      (terminated ? newline : "");
    expect(
      write(source, (document) => {
        movePair(document, ["a"], ["b"], 1);
      }),
    ).toBe(expected);
  });
});
