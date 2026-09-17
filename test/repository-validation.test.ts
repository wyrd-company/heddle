// ---
// relationships:
//   verifies: blueprint-authoring
// ---
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { runCli } from "../src/cli-runner.js";
import {
  validateBlueprintFile,
  validateBlueprintPath,
} from "../src/blueprints/validate.js";
import type { Blueprint, JsonObject } from "../src/blueprints/types.js";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), "blueprint-contract-"));
  directories.push(path);
  return path;
}
function write(root: string, path: string, blueprint: Blueprint) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, stringify(blueprint));
  return file;
}
function child(
  value: unknown = { count: 3 },
  schema: JsonObject = {
    type: "object",
    properties: { count: { type: "integer" } },
    required: ["count"],
  },
): Blueprint {
  return {
    id: "measure",
    kind: "stage",
    outputs: { result: schema },
    nodes: { complete: { uses: "terminal-result", params: { value } } },
  };
}
function parent(
  target = "measure",
  outputs: Record<string, string> = { amount: "result.count" },
): Blueprint {
  return {
    id: "exhibit",
    kind: "process",
    nodes: {
      inspect: {
        uses: "child-run",
        stage: true,
        params: { blueprint: target, outputs },
      },
      done: { uses: "terminal-result", params: { value: "finished" } },
    },
    edges: [
      {
        from: "inspect",
        to: "done",
        when: "result.output.completed or result.output.failed",
      },
    ],
  };
}
function repository(blueprints: Blueprint[] = [parent(), child()]) {
  const root = directory();
  for (const blueprint of blueprints)
    write(root, `${blueprint.id}.yml`, blueprint);
  return root;
}
function rules(root: string) {
  return validateBlueprintPath(root).map((finding) => finding.rule);
}

describe("repository child contracts", () => {
  it("accepts a complete multi-blueprint repository across nested directories", () => {
    const root = directory();
    write(root, "process/exhibit.yml", parent());
    write(root, "stages/measure.yml", child());
    expect(validateBlueprintPath(root)).toEqual([]);
  });
  it("rejects a missing child with parent node and target evidence", () => {
    const root = repository([parent("absent-stage")]);
    expect(validateBlueprintPath(root)).toContainEqual(
      expect.objectContaining({
        file: join(root, "exhibit.yml"),
        node: "inspect",
        rule: "repository.child-missing",
        message: expect.stringContaining("target absent-stage") as string,
      }),
    );
  });
  it("rejects duplicate targets across repository directories", () => {
    const root = repository();
    write(root, "other/measure.yml", child());
    expect(rules(root)).toContain("repository.child-duplicate");
  });
  it.each(["process", "helper"] as const)(
    "rejects wrong %s kind for a stage child",
    (kind) => {
      const root = repository([parent(), { ...child(), kind }]);
      expect(rules(root)).toContain("repository.child-kind");
    },
  );
  it("permits an unmarked child-run to target a process", () => {
    const original = parent();
    const node = original.nodes["inspect"];
    if (node === undefined) throw new Error("Missing fixture node");
    expect(
      rules(
        repository([
          {
            ...original,
            nodes: { ...original.nodes, inspect: { ...node, stage: false } },
          },
          { ...child(), kind: "process" },
        ]),
      ),
    ).toEqual([]);
  });
  it("permits a helper child without stage marking", () => {
    const original = parent();
    const node = original.nodes["inspect"];
    if (node === undefined) throw new Error("Missing fixture node");
    const root = repository([
      {
        ...original,
        nodes: { ...original.nodes, inspect: { ...node, stage: false } },
      },
      { ...child(), kind: "helper" },
    ]);
    expect(validateBlueprintPath(root)).toEqual([]);
  });
  it("rejects unknown nested output paths rather than inferring them from a literal", () => {
    const root = repository([
      parent("measure", { amount: "result.typo" }),
      child({ count: 3, typo: 4 }),
    ]);
    expect(validateBlueprintPath(root)).toContainEqual(
      expect.objectContaining({
        node: "inspect",
        rule: "repository.child-output-path",
        message: expect.stringContaining(
          "mapping amount: result.typo",
        ) as string,
      }),
    );
  });
  it("rejects an undeclared root output", () => {
    expect(
      rules(repository([parent("measure", { amount: "hidden" }), child()])),
    ).toContain("repository.child-output-path");
  });
  it("validates default output mappings", () => {
    const original = parent();
    const node = original.nodes["inspect"];
    if (node === undefined) throw new Error("Missing fixture node");
    const root = repository([
      {
        ...original,
        nodes: {
          ...original.nodes,
          inspect: { ...node, params: { blueprint: "measure" } },
        },
      },
      child(),
    ]);
    expect(validateBlueprintPath(root)).toEqual([]);
  });
  it.each([
    "draft-notes",
    "draft.notes",
    "draft notes",
    'draft\\"notes',
    "__proto__",
    "",
    "`notes`",
  ])(
    "preserves the literal default key %s in repository validation and inferred completion shapes",
    (key) => {
      const original = parent();
      const helper: Blueprint = {
        ...original,
        outputs: {
          result: {
            type: "object",
            properties: Object.fromEntries([[key, { type: "number" }]]),
          },
        },
        nodes: {
          ...original.nodes,
          inspect: { uses: "child-run", params: { blueprint: "measure" } },
          done: {
            uses: "terminal-result",
            params: { value: { from: "inspect.payload" } },
          },
        },
      };
      const source = {
        ...child(),
        outputs: Object.fromEntries([[key, { type: "string" }]]),
      };
      const root = repository([helper, source]);
      const findings = validateBlueprintPath(root);
      expect(
        findings.filter(
          (finding) => finding.rule === "repository.child-output-path",
        ),
      ).toEqual([]);
      expect(findings).toContainEqual(
        expect.objectContaining({
          node: "done",
          rule: "repository.output-shape",
        }),
      );
      write(root, "exhibit.yml", {
        ...helper,
        outputs: {
          result: {
            type: "object",
            properties: Object.fromEntries([[key, { type: "string" }]]),
          },
        },
      });
      expect(validateBlueprintPath(root)).toEqual([]);
    },
  );
  it.each([true, {}])(
    "accepts the same additional member with explicit open-object schema %j",
    (additionalProperties) => {
      const schema = { type: "object", additionalProperties };
      expect(
        validateBlueprintPath(
          repository([
            parent("measure", { amount: "result.extra" }),
            child({ extra: 3 }, schema),
          ]),
        ),
      ).toEqual([]);
    },
  );
  it.each([true, {}])(
    "retains declared property shapes under explicit open-object schema %j",
    (additionalProperties) => {
      const original = parent("measure", { amount: "result.count" });
      const consumer: Blueprint = {
        ...original,
        outputs: { result: { type: "number" } },
        nodes: {
          ...original.nodes,
          done: {
            uses: "terminal-result",
            params: { value: { from: "inspect.payload.amount" } },
          },
        },
      };
      expect(
        rules(
          repository([
            consumer,
            child(
              { count: "three" },
              {
                type: "object",
                properties: { count: { type: "string" } },
                additionalProperties,
              },
            ),
          ]),
        ),
      ).toContain("repository.output-shape");
    },
  );
  it("rejects an additional member with an explicitly closed object schema", () => {
    expect(
      rules(
        repository([
          parent("measure", { amount: "result.extra" }),
          child({}, { type: "object", additionalProperties: false }),
        ]),
      ),
    ).toContain("repository.child-output-path");
  });
  it.each(["wrong", { count: "wrong" }, {}, { count: 2.5 }])(
    "rejects literal terminal shape %j against the declaration",
    (value) => {
      expect(rules(repository([parent(), child(value)]))).toContain(
        "repository.output-shape",
      );
    },
  );
  it("checks every terminal rather than the first completion", () => {
    const original = child();
    const root = repository([
      parent(),
      {
        ...original,
        nodes: {
          ...original.nodes,
          alternative: {
            uses: "terminal-result",
            params: { value: { count: "wrong" } },
          },
        },
      },
    ]);
    expect(validateBlueprintPath(root)).toContainEqual(
      expect.objectContaining({
        node: "alternative",
        rule: "repository.output-shape",
      }),
    );
  });
  it("checks a terminal reference against a declared input shape", () => {
    const original = child({ from: "measurement" });
    const root = repository([
      parent(),
      { ...original, inputs: { measurement: { type: "string" } } },
    ]);
    expect(rules(root)).toContain("repository.output-shape");
  });
  it("checks a child output declaration through a terminal reference", () => {
    const intermediate = parent("measure", { amount: "result.count" });
    const helper: Blueprint = {
      ...intermediate,
      id: "summary",
      kind: "helper",
      outputs: { result: { type: "string" } },
      nodes: {
        ...intermediate.nodes,
        done: {
          uses: "terminal-result",
          params: { value: { from: "inspect.payload.amount" } },
        },
      },
    };
    expect(validateBlueprintPath(repository([helper, child()]))).toContainEqual(
      expect.objectContaining({
        node: "done",
        rule: "repository.output-shape",
      }),
    );
  });
  it("checks declared pass payloads through aggregate bindings", () => {
    const blueprint: Blueprint = {
      id: "summary",
      kind: "stage",
      outputs: {
        result: { type: "object", properties: { score: { type: "number" } } },
      },
      nodes: {
        assess: {
          uses: "pass",
          params: {
            prompt: { inline: "Describe the item." },
            handoff: {
              type: "object",
              description: "Return the label.",
              properties: { label: { type: "string" } },
            },
          },
        },
        combine: {
          uses: "aggregate",
          params: {
            bindings: { score: { node: "assess", path: "payload.label" } },
          },
        },
        complete: {
          uses: "terminal-result",
          params: { value: { from: "combine" } },
        },
      },
      edges: [
        {
          from: "assess",
          to: "combine",
          when: "result.output.handoff or result.output.overridden or result.output.turnEnded",
        },
        { from: "combine", to: "complete" },
      ],
    };
    expect(validateBlueprintPath(repository([blueprint]))).toContainEqual(
      expect.objectContaining({
        node: "complete",
        rule: "repository.output-shape",
      }),
    );
  });
  it("does not import an out-of-directory handoff into static type analysis", () => {
    const root = directory();
    writeFileSync(
      join(root, "outside.yml"),
      stringify({
        type: "object",
        description: "Return the item.",
        properties: { count: { type: "string" } },
      }),
    );
    const nested = join(root, "catalog");
    const blueprint: Blueprint = {
      id: "summary",
      kind: "stage",
      outputs: { result: { type: "number" } },
      nodes: {
        assess: {
          uses: "pass",
          params: {
            prompt: { inline: "Measure the item." },
            handoff: "contract.yml",
          },
        },
        complete: {
          uses: "terminal-result",
          params: { value: { from: "assess.payload.count" } },
        },
      },
      edges: [
        {
          from: "assess",
          to: "complete",
          when: "result.output.handoff or result.output.overridden or result.output.turnEnded",
        },
      ],
    };
    write(nested, "summary.yml", blueprint);
    symlinkSync(join(root, "outside.yml"), join(nested, "contract.yml"));
    expect(rules(nested)).toContain("reference.exists");
    expect(rules(nested)).not.toContain("repository.output-shape");
  });
  it("allows independently loaded schema ids on repeated validation", () => {
    const schema = {
      $id: "https://example.invalid/measurement",
      type: "object",
      properties: { count: { type: "integer" } },
    };
    const root = repository([parent(), child({ count: 3 }, schema)]);
    expect(validateBlueprintPath(root)).toEqual([]);
    expect(validateBlueprintPath(root)).toEqual([]);
  });
  it("accepts optional mapped fields on alternative terminal outcomes", () => {
    const schema = {
      type: "object",
      properties: {
        count: { type: "integer" },
        cancelled: { type: "boolean" },
      },
    };
    const original = child({ count: 3 }, schema);
    const root = repository([
      parent("measure", {
        amount: "result.count",
        cancelled: "result.cancelled",
      }),
      {
        ...original,
        nodes: {
          ...original.nodes,
          cancel: {
            uses: "terminal-result",
            params: { value: { cancelled: true } },
          },
        },
      },
    ]);
    expect(validateBlueprintPath(root)).toEqual([]);
  });
  it("accepts paths declared by a union member", () => {
    const schema = {
      anyOf: [
        {
          type: "object",
          properties: { count: { type: "integer" } },
          required: ["count"],
        },
        {
          type: "object",
          properties: { cancelled: { const: true } },
          required: ["cancelled"],
        },
      ],
    };
    expect(
      validateBlueprintPath(
        repository([parent(), child({ count: 3 }, schema)]),
      ),
    ).toEqual([]);
  });
  it("resolves local schema references and array projection paths", () => {
    const schema = {
      type: "object",
      properties: {
        samples: { type: "array", items: { $ref: "#/$defs/sample" } },
      },
      $defs: {
        sample: { type: "object", properties: { weight: { type: "number" } } },
      },
    };
    expect(
      validateBlueprintPath(
        repository([
          parent("measure", { amount: "result.samples.weight" }),
          child({ samples: [{ weight: 3 }] }, schema),
        ]),
      ),
    ).toEqual([]);
  });
  it("resolves recursive local roots and reference sibling declarations", () => {
    const schema = {
      type: "object",
      properties: {
        count: { type: "integer" },
        next: { $ref: "#", properties: { label: { type: "string" } } },
      },
    };
    expect(
      validateBlueprintPath(
        repository([
          parent("measure", {
            amount: "result.next.next.count",
            label: "result.next.label",
          }),
          child({ count: 3, next: { count: 4, label: "sample" } }, schema),
        ]),
      ),
    ).toEqual([]);
  });
  it("preserves JSONata array projection cardinality for terminal references", () => {
    const original = child(
      { from: "measurements.weight" },
      { type: "array", items: { type: "number" } },
    );
    const blueprint = {
      ...original,
      inputs: {
        measurements: {
          type: "array",
          items: { type: "object", properties: { weight: { type: "number" } } },
        },
      },
    };
    expect(validateBlueprintPath(repository([blueprint]))).toEqual([]);
  });
  it("rejects an unknown member inside a local schema reference", () => {
    const schema = {
      type: "object",
      properties: { detail: { $ref: "#/$defs/sample" } },
      $defs: {
        sample: { type: "object", properties: { weight: { type: "number" } } },
      },
    };
    expect(
      rules(
        repository([
          parent("measure", { amount: "result.detail.typo" }),
          child({ detail: { weight: 3 } }, schema),
        ]),
      ),
    ).toContain("repository.child-output-path");
  });
  it("resolves properties declared across allOf branches", () => {
    const schema = {
      allOf: [
        { type: "object", properties: { count: { type: "integer" } } },
        { type: "object", properties: { label: { type: "string" } } },
      ],
    };
    expect(
      validateBlueprintPath(
        repository([parent(), child({ count: 3, label: "sample" }, schema)]),
      ),
    ).toEqual([]);
  });
  it("anchors terminal shape failures to the parent mapping", () => {
    expect(
      validateBlueprintPath(repository([parent(), child({ count: "wrong" })])),
    ).toContainEqual(
      expect.objectContaining({
        node: "inspect",
        rule: "repository.child-output-shape",
        message: expect.stringContaining(
          "mapping amount: result.count",
        ) as string,
      }),
    );
  });
  it("preserves general JSONata expression support without pretending to prove it", () => {
    const root = repository([
      parent("measure", { amount: "result.count * 2" }),
      child(
        { from: "$sum(measurements)" },
        { type: "object", properties: { count: { type: "integer" } } },
      ),
    ]);
    expect(validateBlueprintPath(root)).toEqual([]);
  });
  it("keeps file-local schema checks separate from repository checks", () => {
    const root = repository([parent("absent-stage")]);
    expect(validateBlueprintFile(join(root, "exhibit.yml"))).toEqual([]);
    expect(rules(root)).toContain("repository.child-missing");
  });
  it("reports malformed output schema declarations", () => {
    const root = repository([
      parent(),
      child({ count: 3 }, { type: "not-a-type" }),
    ]);
    expect(rules(root)).toContain("repository.output-schema");
  });
  it("rejects the accepted absent-stage fixture mutation", () => {
    const root = directory();
    cpSync(resolve("fixtures/blueprints/collection-catalog"), root, {
      recursive: true,
    });
    const file = join(root, "collection-catalog.yml");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "blueprint: stage-assess-collection",
        "blueprint: absent-stage",
      ),
    );
    expect(validateBlueprintPath(root)).toContainEqual(
      expect.objectContaining({
        node: "assess",
        rule: "repository.child-missing",
      }),
    );
    const output: string[] = [];
    const errors: string[] = [];
    expect(
      runCli(["validate", "--json", root], {
        output: (value) => output.push(value),
        error: (value) => errors.push(value),
      }),
    ).toBe(1);
    expect(errors).toEqual([]);
    const findings: unknown = JSON.parse(output.join("\n"));
    expect(findings).toContainEqual(
      expect.objectContaining({
        node: "assess",
        rule: "repository.child-missing",
      }),
    );
  });
  it("publishes every repository finding code through the CLI rule catalog", () => {
    const output: string[] = [];
    expect(
      runCli(["validate", "--rules", "--json"], {
        output: (value) => output.push(value),
        error: () => {
          throw new Error("Unexpected CLI error");
        },
      }),
    ).toBe(0);
    const catalog: unknown = JSON.parse(output.join("\n"));
    for (const suffix of [
      "child-missing",
      "child-duplicate",
      "child-kind",
      "child-output-path",
      "output-schema",
      "output-shape",
      "child-output-shape",
    ])
      expect(catalog).toContainEqual(
        expect.objectContaining({ name: `repository.${suffix}` }),
      );
  });
});
