// ---
// relationships:
//   verifies: blueprint-authoring
// ---
import { describe, expect, it, vi } from "vitest";
import * as comments from "../src/blueprints/yaml-comments.js";
import { readFileSync } from "node:fs";
import { isMap, isNode, parseDocument, type Document, type Node } from "yaml";
import {
  assertPreservedDocument,
  saveLocalizedYaml,
} from "../src/blueprints/source-preserving-yaml.js";
import { applySourcePatches } from "../src/blueprints/yaml-source.js";

function node(document: Document, path: readonly (string | number)[]): Node {
  const value = document.getIn(path, true);
  if (!isNode(value)) throw new Error("Missing test node");
  return value;
}
function key(document: Document, name: string): Node {
  if (!isMap(document.contents)) throw new Error("Missing test map");
  const value = document.contents.items.find(
    (pair) => String(pair.key) === name,
  )?.key;
  if (!isNode(value)) throw new Error("Missing test key");
  return value;
}
interface Probe {
  name: string;
  source: string;
  edit: (document: Document) => void;
  expected: string;
}
const probes: Probe[] = [
  {
    name: "add key to anchored map",
    source: "base: &b\n  x: 1\nuse: *b\n",
    edit: (d) => {
      d.setIn(["base", "y"], 2);
    },
    expected: "base: &b\n  x: 1\n  y: 2\nuse: *b\n",
  },
  {
    name: "collection kind change with the same nested values",
    source: "a:\n  x: y\nb: 2\n",
    edit: (d) => {
      d.set("a", [["x", "y"]]);
    },
    expected: "a:\n  - - x\n    - y\nb: 2\n",
  },
  {
    name: "commentBefore scalar value",
    source: "a: 1\nb: 2\n",
    edit: (d) => {
      node(d, ["a"]).commentBefore = " added";
    },
    expected: "a:\n  # added\n  1\nb: 2\n",
  },
  {
    name: "commentBefore collection value",
    source: "a:\n  x: 1\nb: 2\n",
    edit: (d) => {
      node(d, ["a"]).commentBefore = " added";
    },
    expected: "a:\n  # added\n  x: 1\nb: 2\n",
  },
  {
    name: "anchored scalar edit",
    source: "a: &x 1\nb: *x\n",
    edit: (d) => {
      d.set("a", 2);
    },
    expected: "a: &x 2\nb: *x\n",
  },
  {
    name: "comment removal retains a blank line",
    source: "a: 1\n\n# old\nb: 2\n",
    edit: (d) => {
      key(d, "b").commentBefore = null;
    },
    expected: "a: 1\n\nb: 2\n",
  },
  {
    name: "document trailing comment",
    source: "a: 1\n\n# old\n",
    edit: (d) => {
      d.comment = " changed";
    },
    expected: "a: 1\n\n# changed\n",
  },
  {
    name: "replace scalar with block map",
    source: "a: old\nb: 2\n",
    edit: (d) => {
      d.set("a", { x: 3 });
    },
    expected: "a:\n  x: 3\nb: 2\n",
  },
  {
    name: "replace scalar with block sequence",
    source: "a: old\nb: 2\n",
    edit: (d) => {
      d.set("a", ["x", "y"]);
    },
    expected: "a:\n  - x\n  - y\nb: 2\n",
  },
  {
    name: "remove final key in a block map",
    source: "a:\n  x: 1\nb: 2\n",
    edit: (d) => {
      d.deleteIn(["a", "x"]);
    },
    expected: "a:\n  {}\nb: 2\n",
  },
  {
    name: "delete sequence item keeps collection and survivor comments",
    source: "a:\n  # first\n  - x\n  # second\n  - y\nb: 2\n",
    edit: (d) => {
      d.deleteIn(["a", 0]);
    },
    expected: "a:\n  # first\n  # second\n  - y\nb: 2\n",
  },
  {
    name: "delete key and change surviving comment",
    source: "a: 1\nb: 2    # old\nc: 3\n",
    edit: (d) => {
      d.delete("a");
      node(d, ["b"]).comment = " changed";
    },
    expected: "b: 2    # changed\nc: 3\n",
  },
  {
    name: "insert into middle of block sequence",
    source: "a:\n  - x    # first\n  - z    # last\nb: 2\n",
    edit: (d) => {
      const seq = node(d, ["a"]);
      if (!("items" in seq)) throw new Error("Missing sequence");
      seq.items.splice(1, 0, d.createNode("y"));
    },
    expected: "a:\n  - x    # first\n  - y\n  - z    # last\nb: 2\n",
  },
  {
    name: "append key after empty value",
    source: "a:\n",
    edit: (d) => {
      d.set("b", 2);
    },
    expected: "a:\nb: 2\n",
  },
  {
    name: "comment-only block scalar header",
    source: "a: | # old\n  text\nb: 2\n",
    edit: (d) => {
      node(d, ["a"]).comment = " changed";
    },
    expected: "a: | # changed\n  text\nb: 2\n",
  },
  {
    name: "insert block scalar header comment",
    source: "a: |\n  text\nb: 2\n",
    edit: (d) => {
      node(d, ["a"]).comment = " added";
    },
    expected: "a: | # added\n  text\nb: 2\n",
  },
  {
    name: "empty value with comment",
    source: "a: # keep\nb: 2\n",
    edit: (d) => {
      d.set("a", "x");
    },
    expected: "a: x # keep\nb: 2\n",
  },
  {
    name: "CRLF commentBefore",
    source: "a: 1\r\nb: 2\r\n",
    edit: (d) => {
      key(d, "b").commentBefore = " added\n second";
    },
    expected: "a: 1\r\n# added\r\n# second\r\nb: 2\r\n",
  },
  {
    name: "value and commentBefore in one save",
    source: "# head\na: 1\nb: 2\nz: 3\n",
    edit: (d) => {
      d.set("a", 9);
      key(d, "z").commentBefore = " new";
    },
    expected: "# head\na: 9\nb: 2\n# new\nz: 3\n",
  },
  {
    name: "value and trailing comment removal in one save",
    source: "a: 1\nb: 2 # remove me\n",
    edit: (d) => {
      d.set("a", 3);
      node(d, ["b"]).comment = null;
    },
    expected: "a: 3\nb: 2\n",
  },
  {
    name: "commentBefore on a non-first aligned key",
    source: "a: 1    # first\nb: 2    # second\nz: 3\n",
    edit: (d) => {
      key(d, "b").commentBefore = " inserted";
    },
    expected: "a: 1    # first\n# inserted\nb: 2    # second\nz: 3\n",
  },
  {
    name: "trailing comment keeps its aligned neighbour",
    source: "a: 1    # first\nb: 2    # second\nz: 3\n",
    edit: (d) => {
      node(d, ["a"]).comment = " changed";
    },
    expected: "a: 1    # changed\nb: 2    # second\nz: 3\n",
  },
  {
    name: "add key keeps existing block map bytes",
    source: "a:\n  x: 1    # keep\nz: 3\n",
    edit: (d) => {
      d.setIn(["a", "y"], 2);
    },
    expected: "a:\n  x: 1    # keep\n  y: 2\nz: 3\n",
  },
  {
    name: "delete key keeps existing block map bytes",
    source: "a:\n  x: 1\n  y: 2    # keep\nz: 3\n",
    edit: (d) => d.deleteIn(["a", "x"]),
    expected: "a:\n  y: 2    # keep\nz: 3\n",
  },
  {
    name: "add nested node",
    source: "items:\n  alpha: {x: 1}\nz: 3\n",
    edit: (d) => {
      d.setIn(["items", "beta"], { x: 2 });
    },
    expected: "items:\n  alpha: {x: 1}\n  beta:\n    x: 2\nz: 3\n",
  },
  {
    name: "delete nested node",
    source: "items:\n  alpha: {x: 1}\n  beta: {x: 2}\nz: 3\n",
    edit: (d) => d.deleteIn(["items", "alpha"]),
    expected: "items:\n  beta: {x: 2}\nz: 3\n",
  },
  ...[true, false].map((eof) => ({
    name: `append block sequence ${eof ? "at EOF" : "mid-file"}`,
    source:
      "items:\n  - from: a\n    to: b    # keep\n" + (eof ? "" : "z: 3\n"),
    edit: (d: Document) => {
      d.addIn(["items"], { from: "b", to: "c" });
    },
    expected:
      "items:\n  - from: a\n    to: b    # keep\n  - from: b\n    to: c\n" +
      (eof ? "" : "z: 3\n"),
  })),
  {
    name: "literal block scalar",
    source: "a: |\n  old\nb: 2   # keep\n",
    edit: (d) => {
      d.set("a", "new\nline\n");
    },
    expected: "a: |\n  new\n  line\nb: 2   # keep\n",
  },
  {
    name: "folded block scalar",
    source: "a: >-\n  old\nb: 2   # keep\n",
    edit: (d) => {
      d.set("a", "new text");
    },
    expected: "a: >-\n  new text\nb: 2   # keep\n",
  },
  {
    name: "block map replacement",
    source: "a:\n  old: 1\nb: 2   # keep\n",
    edit: (d) => {
      d.set("a", { next: 3 });
    },
    expected: "a:\n  next: 3\nb: 2   # keep\n",
  },
  {
    name: "block sequence replacement",
    source: "a:\n  - old\nb: 2   # keep\n",
    edit: (d) => {
      d.set("a", ["new", "next"]);
    },
    expected: "a:\n  - new\n  - next\nb: 2   # keep\n",
  },
  {
    name: "anchored map edit leaves alias bytes",
    source: "base: &b\n  x: 1\nuse: *b\nz: 1\n",
    edit: (d) => {
      d.setIn(["base", "x"], 2);
    },
    expected: "base: &b\n  x: 2\nuse: *b\nz: 1\n",
  },
  {
    name: "numeric key",
    source: "codes:\n  200: ok\nz: 1\n",
    edit: (d) => {
      d.setIn(["codes", 200], "changed");
    },
    expected: "codes:\n  200: changed\nz: 1\n",
  },
  {
    name: "boolean key",
    source: "codes:\n  true: ok\nz: 1\n",
    edit: (d) => {
      d.setIn(["codes", true], "changed");
    },
    expected: "codes:\n  true: changed\nz: 1\n",
  },
  {
    name: "empty value receives separator",
    source: "a:\nb: 2   # keep\n",
    edit: (d) => {
      d.set("a", "x");
    },
    expected: "a: x\nb: 2   # keep\n",
  },
  {
    name: "empty value retains existing separator",
    source: "a: \nb: 2   # keep\n",
    edit: (d) => {
      d.set("a", "x");
    },
    expected: "a: x\nb: 2   # keep\n",
  },
  {
    name: "CRLF multiline replacement",
    source: "a: |\r\n  old\r\nb: 2   # keep\r\n",
    edit: (d) => {
      d.set("a", "new\nline\n");
    },
    expected: "a: |\r\n  new\r\n  line\r\nb: 2   # keep\r\n",
  },
  {
    name: "EOF without newline stays unterminated",
    source: "a:\n  - first",
    edit: (d) => {
      d.addIn(["a"], "second");
    },
    expected: "a:\n  - first\n  - second",
  },
  {
    name: "commentBefore replacement preserves blank neighbour",
    source: "a: 1\n\n# old\nb: 2\n",
    edit: (d) => {
      key(d, "b").commentBefore = " new";
    },
    expected: "a: 1\n\n# new\nb: 2\n",
  },
  {
    name: "multiline trailing comment",
    source: "a: 1 # first\n  # second\nb: 2\n",
    edit: (d) => {
      node(d, ["a"]).comment = " changed\n next";
    },
    expected: "a: 1 # changed\n  # next\nb: 2\n",
  },
  {
    name: "block scalar value and header comment",
    source: "a: | # old\n  old\nb: 2\n",
    edit: (d) => {
      d.set("a", "new\n");
      node(d, ["a"]).comment = " changed";
    },
    expected: "a: | # changed\n  new\nb: 2\n",
  },
];

describe("source-preserving YAML adversarial matrix", () => {
  it.each([
    ["semantic", "a: 1 # new\n"],
    ["comment", "a: 2 # old\n"],
  ])("save rejects a lossy %s reconciliation result", (_kind, output) => {
    const source = "a: 1 # old\n";
    const document = parseDocument(source, { keepSourceTokens: true });
    document.set("a", 2);
    node(document, ["a"]).comment = " new";
    const corrupt = vi
      .spyOn(comments, "reconcileComments")
      .mockReturnValue(output);
    try {
      expect(() => {
        saveLocalizedYaml(source, document);
      }).toThrow(/did not preserve/u);
    } finally {
      corrupt.mockRestore();
    }
  });
  it("appends a shipped fixture edge without changing any original byte", () => {
    const source = readFileSync(
      "fixtures/blueprints/recipe-pipeline/recipe-pipeline.yml",
      "utf8",
    );
    const document = parseDocument(source, { keepSourceTokens: true });
    document.addIn(["edges"], { from: "publish", to: "run-failed" });
    expect(saveLocalizedYaml(source, document)).toBe(
      `${source}  - from: publish\n    to: run-failed\n`,
    );
  });
  it("adds a shipped fixture node without changing any original byte", () => {
    const source = readFileSync(
      "fixtures/blueprints/recipe-pipeline/recipe-pipeline.yml",
      "utf8",
    );
    const document = parseDocument(source, { keepSourceTokens: true });
    document.setIn(["nodes", "extra"], { uses: "notify" });
    expect(saveLocalizedYaml(source, document)).toBe(
      source.replace("edges:\n", "  extra:\n    uses: notify\nedges:\n"),
    );
  });
  it.each(probes)("$name", ({ source, edit, expected }) => {
    const document = parseDocument(source, { keepSourceTokens: true });
    edit(document);
    const saved = saveLocalizedYaml(source, document);
    expect(saved).toBe(expected);
    const parsed = parseDocument(saved);
    expect(parsed.errors).toEqual([]);
    expect(parsed.toJS({ mapAsMap: true })).toEqual(
      parseDocument(document.toString()).toJS({ mapAsMap: true }),
    );
  });

  it("rejects valid YAML that loses a semantic edit", () => {
    expect(() => {
      assertPreservedDocument("a: 1\n", parseDocument("a: 2\n"));
    }).toThrow(/did not preserve/u);
  });
  it("rejects invalid YAML even when its parsed value matches", () => {
    expect(() => {
      assertPreservedDocument("a: 1\na: 1\n", parseDocument("a: 1\n"));
    }).toThrow(/did not preserve/u);
  });
  it("rejects overlapping source patches", () => {
    expect(() => {
      applySourcePatches("abc", [
        { start: 0, end: 2, replacement: "x" },
        { start: 1, end: 3, replacement: "y" },
      ]);
    }).toThrow(/Overlapping/u);
  });
  it("rejects valid YAML that loses a comment edit", () => {
    expect(() => {
      assertPreservedDocument("a: 1\n", parseDocument("a: 1 # keep\n"));
    }).toThrow(/did not preserve/u);
  });
  it("rejects valid YAML that moves a comment to another node", () => {
    expect(() => {
      assertPreservedDocument(
        "# keep\na: 1\nb: 2\n",
        parseDocument("a: 1\n# keep\nb: 2\n"),
      );
    }).toThrow(/did not preserve/u);
  });
});
