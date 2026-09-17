// ---
// relationships:
//   verifies: blueprint-authoring
// ---
import { describe, expect, it } from "vitest";
import { isMap, isNode, isScalar, parseDocument, type Document } from "yaml";
import { saveLocalizedYaml } from "../src/blueprints/source-preserving-yaml.js";

const contexts = [
  {
    name: "flow final member",
    source: "top: {a: x, b: y}\nz: 3   # untouched\n",
    path: ["top", "b"],
    parent: ["top"],
  },
  {
    name: "multiline flow final member",
    source: "top: {\n  a: x,\n  b: y\n}\nz: 3   # untouched\n",
    path: ["top", "b"],
    parent: ["top"],
  },
  {
    name: "root",
    source: "a: x\nb: y\nz: 3   # untouched\n",
    path: ["a"],
    parent: [],
  },
  {
    name: "nested map",
    source: "top:\n  a: x\n  b: y\nz: 3   # untouched\n",
    path: ["top", "a"],
    parent: ["top"],
  },
  {
    name: "sequence map",
    source: "top:\n  - a: x\n    b: y\nz: 3   # untouched\n",
    path: ["top", 0, "a"],
    parent: ["top", 0],
  },
  {
    name: "flow map",
    source: "top: {a: x, b: y}\nz: 3   # untouched\n",
    path: ["top", "a"],
    parent: ["top"],
  },
  {
    name: "multiline flow map",
    source: "top: {\n  a: x,\n  b: y\n}\nz: 3   # untouched\n",
    path: ["top", "a"],
    parent: ["top"],
  },
  {
    name: "directive",
    source: "%YAML 1.2\n---\na: x\nb: y\nz: 3   # untouched\n",
    path: ["a"],
    parent: [],
  },
  {
    name: "CRLF nested",
    source: "top:\r\n  a: x\r\n  b: y\r\nz: 3   # untouched\r\n",
    path: ["top", "a"],
    parent: ["top"],
  },
];
const operations: {
  name: string;
  edit: (
    d: Document,
    path: (number | string)[],
    parent: (number | string)[],
  ) => void;
}[] = [
  {
    name: "map replacement",
    edit: (d, path) => {
      d.setIn(path, { k: 1 });
    },
  },
  {
    name: "sequence replacement",
    edit: (d, path) => {
      d.setIn(path, ["x", "y"]);
    },
  },
  {
    name: "multiline scalar",
    edit: (d, path) => {
      d.setIn(path, "first\nsecond");
    },
  },
  {
    name: "single-quoted scalar",
    edit: (d, path) => {
      const n = d.getIn(path, true);
      if (isScalar(n)) n.type = "QUOTE_SINGLE";
    },
  },
  {
    name: "literal scalar",
    edit: (d, path) => {
      const n = d.getIn(path, true);
      if (isScalar(n)) {
        n.type = "BLOCK_LITERAL";
        n.value = "first\nsecond";
      }
    },
  },
  {
    name: "scalar comment",
    edit: (d, path) => {
      const n = d.getIn(path, true);
      if (isNode(n)) n.comment = " added";
    },
  },
  {
    name: "scalar commentBefore",
    edit: (d, path) => {
      const n = d.getIn(path, true);
      if (isNode(n)) n.commentBefore = " added";
    },
  },
  {
    name: "rename key",
    edit: (d, _path, parent) => {
      const n = parent.length ? d.getIn(parent, true) : d.contents;
      if (isMap(n) && isScalar(n.items[0]?.key)) n.items[0].key.value = "c";
    },
  },
  {
    name: "flow parent",
    edit: (d, _path, parent) => {
      const n = parent.length ? d.getIn(parent, true) : d.contents;
      if (isMap(n)) n.flow = true;
    },
  },
  {
    name: "block parent",
    edit: (d, _path, parent) => {
      const n = parent.length ? d.getIn(parent, true) : d.contents;
      if (isMap(n)) n.flow = false;
    },
  },
];

describe("independent YAML context and operation combinations", () => {
  for (const context of contexts)
    for (const operation of operations)
      it(`${context.name}: ${operation.name}`, () => {
        const document = parseDocument(context.source, {
          keepSourceTokens: true,
        });
        operation.edit(document, context.path, context.parent);
        const saved = saveLocalizedYaml(context.source, document);
        const parsed = parseDocument(saved);
        expect(parsed.errors).toEqual([]);
        expect(parsed.toJS()).toEqual(
          parseDocument(document.toString()).toJS(),
        );
        expect(parsed.toString().replaceAll("\r\n", "\n")).toBe(
          parseDocument(document.toString())
            .toString()
            .replaceAll("\r\n", "\n"),
        );
        if (context.parent.length || operation.name !== "flow parent")
          expect(saved).toContain(
            context.source
              .split(/\r?\n/u)
              .find((line) => line.startsWith("z:")),
          );
        expect(saved).not.toMatch(/[ \t]+\r?$/mu);
      });
});
