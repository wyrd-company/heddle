// ---
// relationships:
//   verifies: blueprint-authoring
// ---
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  type Document,
  type Node,
} from "yaml";
import {
  assertPreservedDocument,
  saveLocalizedYaml,
} from "../src/blueprints/source-preserving-yaml.js";
import * as presentation from "../src/blueprints/yaml-presentation.js";

function node(d: Document, path: (number | string)[]): Node {
  const n = d.getIn(path, true);
  if (!isNode(n)) throw new Error("Missing node");
  return n;
}
function key(d: Document, name: string): Node {
  if (!isMap(d.contents)) throw new Error("Missing map");
  const k = d.contents.items.find(
    (p) => isScalar(p.key) && p.key.value === name,
  )?.key;
  if (!isNode(k)) throw new Error("Missing key");
  return k;
}
function write(source: string, edit: (d: Document) => void): string {
  const document = parseDocument(source, { keepSourceTokens: true });
  const formatted = document.toString();
  edit(document);
  return saveLocalizedYaml(source, formatted, document);
}

describe("YAML presentation and creation matrix", () => {
  it("clears explicitly deleted scalar style", () => {
    expect(
      write("a: 'x'\nb: 2\n", (d) => {
        const a = node(d, ["a"]);
        if (isScalar(a)) delete a.type;
      }),
    ).toBe("a: x\nb: 2\n");
  });
  it("clears explicitly deleted flow style", () => {
    expect(
      write("a: [x, y]\nb: 2\n", (d) => {
        const a = node(d, ["a"]);
        if (isSeq(a)) delete a.flow;
      }),
    ).toBe("a:\n  - x\n  - y\nb: 2\n");
  });
  it("numeric format metadata", () => {
    expect(
      write("a: 16\nb: 2\n", (d) => {
        const a = node(d, ["a"]);
        if (isScalar(a)) a.format = "HEX";
      }),
    ).toBe("a: 0x10\nb: 2\n");
  });
  it("fractional precision metadata", () => {
    expect(
      write("a: 1.2\nb: 2\n", (d) => {
        const a = node(d, ["a"]);
        if (isScalar(a)) a.minFractionDigits = 3;
      }),
    ).toBe("a: 1.200\nb: 2\n");
  });
  it("spaceBefore on a sequence item", () => {
    expect(
      write("a:\n  - x\n  - y\nb: 2\n", (d) => {
        node(d, ["a", 1]).spaceBefore = true;
      }),
    ).toBe("a:\n  - x\n\n  - y\nb: 2\n");
  });
  it("spaceBefore with an attached comment", () => {
    expect(
      write("a: 1\n# keep\nb: 2\n", (d) => {
        key(d, "b").spaceBefore = true;
      }),
    ).toBe("a: 1\n\n# keep\nb: 2\n");
  });
  it("removes spaceBefore with an attached comment", () => {
    expect(
      write("a: 1\n\n# keep\nb: 2\n", (d) => {
        key(d, "b").spaceBefore = false;
      }),
    ).toBe("a: 1\n# keep\nb: 2\n");
  });
  it("spaceBefore and a new comment in one edit", () => {
    expect(
      write("a: 1\nb: 2\n", (d) => {
        const b = key(d, "b");
        b.spaceBefore = true;
        b.commentBefore = " added";
      }),
    ).toBe("a: 1\n\n# added\nb: 2\n");
  });
  it("renames a key in a multiline flow map without changing the value", () => {
    const source = "a: {\n  b: [1, 2],\n  c: 3\n}\nz: 4\n";
    expect(
      write(source, (d) => {
        const a = node(d, ["a"]);
        if (isMap(a) && isScalar(a.items[0]?.key)) a.items[0].key.value = "d";
      }),
    ).toBe(source.replace("  b:", "  d:"));
  });
  it("replaces a sequence scalar with a map without trailing spaces", () => {
    expect(
      write("a:\n  - x\nb: 2\n", (d) => {
        d.setIn(["a", 0], { k: 1 });
      }),
    ).toBe("a:\n  -\n    k: 1\nb: 2\n");
  });
  it("creates contents after an unterminated header comment", () => {
    expect(
      write("# header", (d) => {
        d.contents = d.createNode({ a: 1 });
      }),
    ).toBe("# header\n\na: 1\n");
  });
  for (const ending of ["\n", "\r\n"]) {
    for (const prefix of ["", "%YAML 1.2\n---\n"]) {
      for (const mixed of [false, true]) {
        const label = `${ending === "\n" ? "LF" : "CRLF"}, ${prefix ? "directive" : "plain"}, ${mixed ? "mixed" : "presentation only"}`;
        const source = (prefix + "a: x   # keep\nb: 2\n").replaceAll(
          "\n",
          ending,
        );
        const expected = (body: string): string =>
          (prefix + body).replaceAll("\n", ending);
        it(`adds spaceBefore (${label})`, () => {
          expect(
            write(source, (d) => {
              key(d, "b").spaceBefore = true;
              if (mixed) d.set("a", "y");
            }),
          ).toBe(expected(`a: ${mixed ? "y" : "x"}   # keep\n\nb: 2\n`));
        });
        it(`removes spaceBefore (${label})`, () => {
          expect(
            write(source.replace(`b: 2`, `${ending}b: 2`), (d) => {
              key(d, "b").spaceBefore = false;
              if (mixed) d.set("a", "y");
            }),
          ).toBe(expected(`a: ${mixed ? "y" : "x"}   # keep\nb: 2\n`));
        });
        for (const type of ["QUOTE_DOUBLE", "QUOTE_SINGLE"] as const)
          it(`scalar ${type} (${label})`, () => {
            expect(
              write(source, (d) => {
                const a = node(d, ["a"]);
                if (isScalar(a)) a.type = type;
                if (mixed) d.set("b", 3);
              }),
            ).toBe(
              expected(
                `a: ${type === "QUOTE_DOUBLE" ? '"x"' : "'x'"}   # keep\nb: ${mixed ? "3" : "2"}\n`,
              ),
            );
          });
        it(`block sequence becomes flow (${label})`, () => {
          const input = expected("a:\n  - x\n  - y\nb: 2\n");
          expect(
            write(input, (d) => {
              const a = node(d, ["a"]);
              if (isSeq(a)) a.flow = true;
              if (mixed) d.set("b", 3);
            }),
          ).toBe(expected(`a:\n  [ x, y ]\nb: ${mixed ? "3" : "2"}\n`));
        });
        it(`flow sequence becomes block (${label})`, () => {
          const input = expected("a: [x, y]\nb: 2\n");
          expect(
            write(input, (d) => {
              const a = node(d, ["a"]);
              if (isSeq(a)) a.flow = false;
              if (mixed) d.set("b", 3);
            }),
          ).toBe(expected(`a:\n  - x\n  - y\nb: ${mixed ? "3" : "2"}\n`));
        });
      }
    }
  }

  it.each([
    ["top-level", "a: x\nb: 2\n", ["a"], "a: first\n\n  second\nb: 2\n"],
    [
      "nested",
      "top:\n  a: x\nb: 2\n",
      ["top", "a"],
      "top:\n  a: first\n\n    second\nb: 2\n",
    ],
    [
      "sequence",
      "a:\n  - x\nb: 2\n",
      ["a", 0],
      "a:\n  - first\n\n    second\nb: 2\n",
    ],
  ] as const)("multiline plain scalar %s", (_name, source, path, expected) => {
    const saved = write(source, (d) => {
      d.setIn(path, "first\nsecond");
    });
    expect(saved).toBe(expected);
    expect(saved).not.toMatch(/[ \t]+\r?$/mu);
  });
  it.each(["description", "when"])("multiline shipped fixture %s", (field) => {
    const source = readFileSync(
      "fixtures/blueprints/recipe-pipeline/recipe-pipeline.yml",
      "utf8",
    );
    const d = parseDocument(source);
    const path =
      field === "description" ? ["description"] : ["edges", 0, "when"];
    const before = node(d, path);
    if (!before.range) throw new Error("Missing range");
    const indent = field === "description" ? "  " : "      ";
    const expected =
      source.slice(0, before.range[0]) +
      `first\n\n${indent}second` +
      source.slice(before.range[1]);
    expect(
      write(source, (doc) => {
        doc.setIn(path, "first\nsecond");
      }),
    ).toBe(expected);
  });
  it("renames a key while preserving its full value slice", () => {
    const source = "a:\n  x: [1, 2]   # keep\n\n  y: 3\nb: 2\n";
    expect(
      write(source, (d) => {
        const a = key(d, "a");
        if (isScalar(a)) a.value = "c";
      }),
    ).toBe(source.replace(/^a:/u, "c:"));
  });
  it("replaces a key node while preserving its full value slice", () => {
    const source = "a:\n  x: [1, 2]   # keep\n\n  y: 3\nb: 2\n";
    expect(
      write(source, (d) => {
        if (isMap(d.contents) && d.contents.items[0])
          d.contents.items[0].key = d.createNode("c");
      }),
    ).toBe(source.replace(/^a:/u, "c:"));
  });
  it("replaces a scalar with an alias", () => {
    expect(
      write("a: &x 1\nb: 2\n", (d) => {
        const a = node(d, ["a"]);
        if (!isScalar(a)) throw new Error("Missing scalar");
        d.set("b", d.createAlias(a));
      }),
    ).toBe("a: &x 1\nb: *x\n");
  });
  it.each(["", "# only comment\n"])("creates contents in %j", (source) => {
    expect(
      write(source, (d) => {
        d.contents = d.createNode({ a: 1 });
      }),
    ).toBe(source + (source ? "\n" : "") + "a: 1\n");
  });
  it("rejects dropped presentation at the save boundary", () => {
    const spy = vi
      .spyOn(presentation, "reconcileSpacing")
      .mockImplementation((source) => source);
    try {
      expect(() =>
        write("a: 1\nb: 2\n", (d) => {
          key(d, "b").spaceBefore = true;
        }),
      ).toThrow(/did not preserve/u);
    } finally {
      spy.mockRestore();
    }
  });
  it.each([
    ["spaceBefore", "a: 1\nb: 2\n", "a: 1\n\nb: 2\n"],
    ["numeric format", "a: 16\n", "a: 0x10\n"],
    ["fractional precision", "a: 1.2\n", "a: 1.200\n"],
    ["document directive", "a: 1\n", "%YAML 1.2\n---\na: 1\n"],
    ["document end marker", "a: 1\n", "a: 1\n...\n"],
    ["scalar type", "a: x\n", "a: 'x'\n"],
    ["flow", "a:\n  - x\n", "a: [x]\n"],
  ])("rejects lost %s metadata", (_field, saved, expected) => {
    expect(() => {
      assertPreservedDocument(saved, parseDocument(expected));
    }).toThrow(/did not preserve/u);
  });
});
