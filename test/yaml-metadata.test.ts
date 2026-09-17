// ---
// relationships:
//   verifies: blueprint-authoring
// ---
import { describe, expect, it } from "vitest";
import {
  isMap,
  isNode,
  isScalar,
  parseDocument,
  type Document,
  type Node,
} from "yaml";
import { saveBlueprint } from "../src/blueprints/loader.js";
import type { Blueprint, LoadedBlueprint } from "../src/blueprints/types.js";

function node(document: Document, path: readonly (string | number)[]): Node {
  const value = document.getIn(path, true);
  if (!isNode(value)) throw new Error("Missing test node");
  return value;
}

function key(document: Document, name: string): Node {
  if (!isMap(document.contents)) throw new Error("Missing test map");
  const value = document.contents.items.find(
    (pair) => isScalar(pair.key) && pair.key.value === name,
  )?.key;
  if (!isNode(value)) throw new Error("Missing test key");
  return value;
}

function directives(document: Document): NonNullable<Document["directives"]> {
  if (!document.directives) throw new Error("Missing test directives");
  return document.directives;
}

function write(source: string, edit: (document: Document) => void): string {
  const document = parseDocument(source, { keepSourceTokens: true });
  const value: unknown = document.toJS();
  const loaded: LoadedBlueprint = {
    filePath: "/test/metadata.yml",
    source,
    document,
    blueprint: value as Blueprint,
    formattedSource: document.toString(),
    originalValue: structuredClone(value),
  };
  edit(document);
  return saveBlueprint(loaded);
}

const contexts = [
  {
    name: "block map scalar",
    source: (property: string) =>
      `top:\n  value: ${property}text   # keep\nz: 3\n`,
    path: ["top", "value"],
  },
  {
    name: "block sequence scalar",
    source: (property: string) => `top:\n  - ${property}text   # keep\nz: 3\n`,
    path: ["top", 0],
  },
  {
    name: "flow sequence scalar",
    source: (property: string) =>
      `top: [${property}text, keep]   # untouched\nz: 3\n`,
    path: ["top", 0],
  },
  {
    name: "nested block collection",
    source: (property: string) =>
      `top:\n  value:${property ? ` ${property.trimEnd()}` : ""}\n    nested: 1   # keep\nz: 3\n`,
    path: ["top", "value"],
  },
  {
    name: "CRLF scalar without final newline",
    source: (property: string) =>
      `top:\r\n  value: ${property}text   # keep\r\nz: 3`,
    path: ["top", "value"],
  },
] as const;

const operations = [
  {
    name: "add anchor",
    before: "",
    after: "&next ",
    edit: (value: Node) => {
      value.anchor = "next";
    },
  },
  {
    name: "rename anchor",
    before: "&old ",
    after: "&next ",
    edit: (value: Node) => {
      value.anchor = "next";
    },
  },
  {
    name: "remove anchor",
    before: "&old ",
    after: "",
    edit: (value: Node) => {
      delete value.anchor;
    },
  },
  {
    name: "add tag",
    before: "",
    after: "!kind ",
    edit: (value: Node) => {
      value.tag = "!kind";
    },
  },
  {
    name: "change tag",
    before: "!old ",
    after: "!next ",
    edit: (value: Node) => {
      value.tag = "!next";
    },
  },
  {
    name: "remove tag",
    before: "!old ",
    after: "",
    edit: (value: Node) => {
      delete value.tag;
    },
  },
] as const;

describe("YAML anchor and tag operation/context matrix", () => {
  for (const context of contexts)
    for (const operation of operations)
      it(`${context.name}: ${operation.name}`, () => {
        const source = context.source(operation.before);
        const expected = context.source(operation.after);
        const saved = write(source, (document) => {
          operation.edit(node(document, context.path));
        });
        expect(saved).toBe(expected);
        expect(saved).not.toMatch(/[ \t]+\r?$/mu);
      });
});

describe("YAML aliases with edited anchors", () => {
  it("changes a tag without moving its untouched anchor", () => {
    expect(
      write("a: !old &keep text   # untouched\n", (document) => {
        node(document, ["a"]).tag = "!next";
      }),
    ).toBe("a: !next &keep text   # untouched\n");
  });

  it("renames an anchor and its aliases without changing other bytes", () => {
    const source = "base: &old\n  value: [1, 2]   # keep\nuse: *old\nz: 3\n";
    expect(
      write(source, (document) => {
        node(document, ["base"]).anchor = "next";
        const alias = node(document, ["use"]);
        if (!("source" in alias)) throw new Error("Missing alias");
        alias.source = "next";
      }),
    ).toBe(source.replaceAll("old", "next"));
  });

  it("removes an anchor while replacing its alias", () => {
    expect(
      write("base: &old value\nuse: *old\nz: 3\n", (document) => {
        delete node(document, ["base"]).anchor;
        document.set("use", "copy");
      }),
    ).toBe("base: value\nuse: copy\nz: 3\n");
  });

  it("rejects a dangling alias after an anchor rename", () => {
    const source = "base: &old value\nuse: *old\nz: 3\n";
    expect(() =>
      write(source, (document) => {
        node(document, ["base"]).anchor = "next";
      }),
    ).toThrow();
    expect(source).toBe("base: &old value\nuse: *old\nz: 3\n");
  });
});

describe("YAML document markers and directives", () => {
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("adds and removes document start markers with %s", (_name, newline) => {
    const plain = `# heading${newline}a: 1   # keep${newline}`;
    const marked = `---${newline}${plain}`;
    expect(
      write(plain, (document) => {
        directives(document).docStart = true;
      }),
    ).toBe(marked);
    expect(
      write(marked, (document) => {
        directives(document).docStart = null;
      }),
    ).toBe(plain);
  });

  it("adds a document end marker after unterminated contents", () => {
    expect(
      write("a: 1", (document) => {
        directives(document).docEnd = true;
      }),
    ).toBe("a: 1\n...\n");
  });

  it("removes a document end marker while retaining trailing comments", () => {
    expect(
      write("a: 1\n... # end\n# tail\n", (document) => {
        directives(document).docEnd = false;
      }),
    ).toBe("a: 1\n# end\n# tail\n");
  });

  it("adds, changes and removes the YAML version directive", () => {
    const plain = "# heading\na: 1   # keep\n";
    const yaml12 = "%YAML 1.2\n---\n# heading\na: 1   # keep\n";
    const yaml11 = yaml12.replace("1.2", "1.1");
    expect(
      write(plain, (document) => {
        directives(document).yaml.explicit = true;
      }),
    ).toBe(yaml12);
    expect(
      write(yaml12, (document) => {
        directives(document).yaml.version = "1.1";
      }),
    ).toBe(yaml11);
    expect(
      write(yaml12, (document) => {
        directives(document).yaml.explicit = false;
      }),
    ).toBe("---\n# heading\na: 1   # keep\n");
  });

  it("adds, changes and removes a TAG directive", () => {
    const plain = "---\na: value   # keep\n";
    const first = "%TAG !e! tag:example.com,first:\n---\na: value   # keep\n";
    const next = first.replace("first", "next");
    expect(
      write(plain, (document) => {
        directives(document).tags["!e!"] = "tag:example.com,first:";
      }),
    ).toBe(first);
    expect(
      write(first, (document) => {
        directives(document).tags["!e!"] = "tag:example.com,next:";
      }),
    ).toBe(next);
    expect(
      write(first, (document) => {
        delete directives(document).tags["!e!"];
      }),
    ).toBe(plain);
  });

  it("adds YAML and TAG directives in the required order", () => {
    expect(
      write("# heading\na: value\n", (document) => {
        directives(document).yaml.explicit = true;
        directives(document).tags["!e!"] = "tag:example.com,value:";
      }),
    ).toBe(
      "%YAML 1.2\n%TAG !e! tag:example.com,value:\n---\n# heading\na: value\n",
    );
  });

  it("changes a used TAG directive with its expanded node tag", () => {
    expect(
      write(
        "%TAG !e! tag:example.com,first:\n---\na: !e!value text   # keep\n",
        (document) => {
          directives(document).tags["!e!"] = "tag:example.com,next:";
          node(document, ["a"]).tag = "tag:example.com,next:value";
        },
      ),
    ).toBe("%TAG !e! tag:example.com,next:\n---\na: !e!value text   # keep\n");
  });

  it("combines directive, semantic, comment and presentation edits", () => {
    expect(
      write(
        "%YAML 1.2\r\n---\r\na: &old text   # old\r\nb: 2\r\n...\r\n",
        (document) => {
          directives(document).yaml.version = "1.1";
          directives(document).docEnd = false;
          const a = node(document, ["a"]);
          a.anchor = "next";
          a.tag = "tag:yaml.org,2002:str";
          a.comment = " changed";
          document.set("b", 3);
          key(document, "b").spaceBefore = true;
        },
      ),
    ).toBe(
      "%YAML 1.1\r\n---\r\na: &next !!str text   # changed\r\n\r\nb: 3\r\n",
    );
  });
});
