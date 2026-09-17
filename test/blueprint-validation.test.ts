// ---
// relationships:
//   verifies:
//     - blueprint-authoring
//     - node-types
// ---
import {
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
import { parseDocument } from "yaml";

import {
  deriveFlowcraftBlueprint,
  lintDerivedBlueprint,
  loadBlueprint,
  loadValidatedBlueprint,
  NODE_TYPE_REGISTRY,
  roundTripBlueprintBytes,
  saveBlueprint,
  validateBlueprintFile,
  validateBlueprintPath,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryFile(name: string, source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "heddle-blueprint-"));
  temporaryDirectories.push(directory);
  const file = join(directory, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  return file;
}

function passBlueprint(overrides = ""): string {
  return `# This comment must survive an unchanged save.
id: sample-a
kind: stage
nodes:
  first:
    uses: pass
    params:
      prompt: { inline: "Complete the request." }
      handoff:
        type: object
        description: Submit the result.
        properties:
          value: { type: string }
  done:
    uses: notify
    params:
      channel: pushover
      title: { inline: "Complete" }
edges:
  - from: first
    to: done
    when: result.output.handoff or result.output.overridden or result.output.turnEnded
${overrides}`;
}

function policyBlueprint(): string {
  return `id: sample-a
kind: helper
inputs:
  item: {}
nodes:
  select:
    uses: policy
    params:
      rules: rules/policy.yml
      input: { from: item }
`;
}

function policyFixture(source: string): {
  readonly blueprint: string;
  readonly policy: string;
} {
  const blueprint = temporaryFile("sample-a.yml", policyBlueprint());
  const policy = join(dirname(blueprint), "rules/policy.yml");
  mkdirSync(dirname(policy), { recursive: true });
  writeFileSync(policy, source);
  return { blueprint, policy };
}

const validPolicy = `rules:
  - id: preferred
    when: category = 'Preferred'
    blueprint: selected-route
    inputs:
      item: { from: "$" }
      threshold: 3
  - id: fallback
    blueprint: fallback-route
`;

function scalarPaths(
  value: unknown,
  path: readonly (number | string)[] = [],
): (readonly (number | string)[])[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => scalarPaths(item, [...path, index]));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) =>
      scalarPaths(item, [...path, key]),
    );
  }
  return [path];
}

function changedScalar(value: unknown): unknown {
  if (typeof value === "string") return `${value}X`;
  if (typeof value === "number") return value + 1;
  if (typeof value === "boolean") return !value;
  return "X";
}

describe("blueprint loading", () => {
  it("preserves every source byte on an unchanged save", () => {
    const file = resolve(
      "fixtures/blueprints/recipe-pipeline/recipe-pipeline.yml",
    );
    const loaded = loadBlueprint(file);

    expect(saveBlueprint(loaded)).toBe(readFileSync(file, "utf8"));
  });

  it("preserves a comment-only document edit", () => {
    const file = resolve(
      "fixtures/blueprints/recipe-pipeline/recipe-pipeline.yml",
    );
    const loaded = loadBlueprint(file);
    loaded.document.commentBefore = "Added document comment.";

    expect(
      saveBlueprint(loaded).startsWith(
        "#Added document comment.\n\n# A recipe moves",
      ),
    ).toBe(true);
  });

  it("preserves untouched lines around a localized value edit", () => {
    const file = resolve(
      "fixtures/blueprints/recipe-pipeline/recipe-pipeline.yml",
    );
    const source = readFileSync(file, "utf8");
    const loaded = loadBlueprint(file);
    loaded.document.setIn(["description"], "Updated catalog description.");

    expect(saveBlueprint(loaded)).toBe(
      source.replace(
        "description: Editorial pipeline for a recipe catalog.",
        "description: Updated catalog description.",
      ),
    );
  });

  it("preserves an aligned-comment neighbour around a scalar edit", () => {
    const source = "a: 1    # first\nb: 2    # second\nz: 3\n";
    const loaded = loadBlueprint(temporaryFile("aligned.yml", source));
    loaded.document.setIn(["a"], 5);

    expect(saveBlueprint(loaded)).toBe(
      "a: 5    # first\nb: 2    # second\nz: 3\n",
    );
  });

  it("preserves a flow-sequence neighbour when replacing the sequence", () => {
    const source = "tags: [x, y]\nlist: [p, q]\nz: 3\n";
    const loaded = loadBlueprint(temporaryFile("flow.yml", source));
    loaded.document.setIn(["tags"], ["changed"]);

    expect(saveBlueprint(loaded)).toBe(
      "tags: [ changed ]\nlist: [p, q]\nz: 3\n",
    );
  });

  it.each([3, 4])(
    "preserves untouched recipe lines when editing long condition %i",
    (edgeIndex) => {
      const file = resolve(
        "fixtures/blueprints/recipe-pipeline/recipe-pipeline.yml",
      );
      const source = readFileSync(file, "utf8");
      const loaded = loadBlueprint(file);
      const path = ["edges", edgeIndex, "when"] as const;
      const condition = loaded.document.getIn(path);
      expect(typeof condition).toBe("string");
      loaded.document.setIn(path, `${String(condition)}X`);

      const saved = saveBlueprint(loaded);
      expect(saved).toBe(
        source.replace(String(condition), `${String(condition)}X`),
      );
      const reparsed = parseDocument(saved);
      expect(reparsed.errors).toEqual([]);
      expect(reparsed.toJS()).toEqual(loaded.document.toJS());
    },
  );

  it("preserves semantics when editing every scalar in the shipped fixture", () => {
    const file = resolve(
      "fixtures/blueprints/recipe-pipeline/recipe-pipeline.yml",
    );
    const initial: unknown = loadBlueprint(file).document.toJS();

    for (const path of scalarPaths(initial)) {
      const loaded = loadBlueprint(file);
      loaded.document.setIn(path, changedScalar(loaded.document.getIn(path)));
      const saved = saveBlueprint(loaded);
      const reparsed = parseDocument(saved);
      expect(reparsed.errors, path.join(".")).toEqual([]);
      expect(reparsed.toJS(), path.join(".")).toEqual(loaded.document.toJS());
    }
  });

  it("proves byte round-trip through a reversible localized edit", () => {
    const loaded = loadBlueprint(
      resolve("fixtures/blueprints/recipe-pipeline/recipe-pipeline.yml"),
    );

    expect(roundTripBlueprintBytes(loaded)).toBe(true);
  });

  it("offers the full check chain as the service load boundary", () => {
    const valid = temporaryFile("sample-a.yml", passBlueprint());
    const invalid = temporaryFile(
      "sample-a.yml",
      passBlueprint().replace(
        "result.output.handoff or result.output.overridden or result.output.turnEnded",
        "result.output.handoff",
      ),
    );

    expect(loadValidatedBlueprint(valid).blueprint.id).toBe("sample-a");
    expect(() => loadValidatedBlueprint(invalid)).toThrow(
      /heddle\.unhandled-result/u,
    );
  });

  it("derives Flowcraft nodes and JSONata conditions without action edges", () => {
    const loaded = loadBlueprint(
      temporaryFile("sample-a.yml", passBlueprint()),
    );
    const derived = deriveFlowcraftBlueprint(loaded.blueprint);

    expect(derived.nodes.map((node) => node.id)).toEqual(["first", "done"]);
    expect(derived.edges).toEqual([
      {
        source: "first",
        target: "done",
        condition:
          "result.output.handoff or result.output.overridden or result.output.turnEnded",
      },
    ]);
    expect(derived.edges.every((edge) => edge.action === undefined)).toBe(true);
  });
});

describe("validation chain", () => {
  it("keeps the policy catalog aligned with the rule selection contract", () => {
    const catalog = parseDocument(
      readFileSync(resolve("docs/technical-designs/node-types.yml"), "utf8"),
    ).toJS() as { readonly "proposed-design"?: { readonly policy?: unknown } };
    const schema = parseDocument(
      readFileSync(
        resolve("docs/specifications/policy-rule.schema.yml"),
        "utf8",
      ),
    ).toJS() as {
      readonly $defs?: {
        readonly rule?: {
          readonly properties?: Readonly<Record<string, unknown>>;
          readonly required?: readonly string[];
        };
      };
    };
    const policy = catalog["proposed-design"]?.policy;

    expect(schema.$defs?.rule?.required).toEqual(["id", "blueprint"]);
    expect(schema.$defs?.rule?.properties).toHaveProperty("inputs");
    expect(policy).toContain(
      "Output: the selected rule id, blueprint id, and bound inputs.",
    );
    expect(policy).not.toContain("turnEndPolicy");
  });

  it("accepts every shipped blueprint fixture", () => {
    const fixtureDirectory = resolve("fixtures/blueprints");

    expect(validateBlueprintPath(fixtureDirectory)).toEqual([]);
  });

  it("passes Flowcraft lint after deriving the cyclic fixture entry", () => {
    const loaded = loadBlueprint(
      resolve("fixtures/blueprints/recipe-pipeline/recipe-pipeline.yml"),
    );
    const derived = deriveFlowcraftBlueprint(loaded.blueprint);

    expect(derived.metadata?.cycleEntryPoints).toEqual(["draft"]);
    expect(lintDerivedBlueprint(loaded.blueprint)).toEqual([]);
  });

  it("requires every named child-run result from the node-type registry", () => {
    const fixture = readFileSync(
      resolve("fixtures/blueprints/recipe-pipeline/recipe-pipeline.yml"),
      "utf8",
    );
    const source = fixture.replace(
      "  - from: draft\n    to: run-failed\n    when: result.output.failed\n",
      "",
    );
    const file = temporaryFile("recipe-pipeline.yml", source);

    expect(validateBlueprintFile(file)).toContainEqual(
      expect.objectContaining({
        node: "draft",
        rule: "heddle.unhandled-result",
        message: "Result is not handled: failed",
      }),
    );
  });

  it("requires an explicit authored entry for a fully cyclic graph", () => {
    const cyclic = passBlueprint().replace(
      "  - from: first\n    to: done\n    when: result.output.handoff or result.output.overridden or result.output.turnEnded",
      "  - from: first\n    to: done\n    when: result.output.handoff or result.output.overridden or result.output.turnEnded\n  - from: done\n    to: first",
    );
    const missing = temporaryFile("sample-a.yml", cyclic);
    const unknown = temporaryFile(
      "sample-a.yml",
      cyclic.replace("kind: stage", "kind: stage\nentry: absent"),
    );

    expect(validateBlueprintFile(missing)).toContainEqual(
      expect.objectContaining({ rule: "heddle.entry" }),
    );
    expect(validateBlueprintFile(unknown)).toContainEqual(
      expect.objectContaining({ rule: "heddle.entry" }),
    );
  });

  it("rejects an explicit entry when the graph has a natural start", () => {
    const file = temporaryFile(
      "sample-a.yml",
      passBlueprint().replace("kind: stage", "kind: stage\nentry: done"),
    );

    expect(validateBlueprintFile(file)).toContainEqual(
      expect.objectContaining({
        node: "$blueprint",
        rule: "heddle.entry",
        message: "Entry is only valid for a graph with no natural start",
      }),
    );
  });

  it("validates a directory while ignoring referenced schema documents", () => {
    const file = temporaryFile("sample-a/sample-a.yml", passBlueprint());
    writeFileSync(
      join(dirname(file), "contract.yml"),
      "type: object\ndescription: A contract.\nproperties: {}\n",
    );

    expect(validateBlueprintPath(dirname(dirname(file)))).toEqual([]);
  });

  it("finds invalid blueprints recursively in a directory", () => {
    const file = temporaryFile(
      "nested/different.yml",
      passBlueprint()
        .replace("id: sample-a", "id: different")
        .replace(
          "result.output.handoff or result.output.overridden or result.output.turnEnded",
          "result.output.handoff",
        ),
    );

    expect(validateBlueprintPath(dirname(dirname(file)))).toContainEqual(
      expect.objectContaining({
        file,
        node: "first",
        rule: "heddle.unhandled-result",
      }),
    );
  });

  it("reports malformed YAML as a parse finding", () => {
    const file = temporaryFile("sample-a.yml", "id: [\n");

    expect(validateBlueprintFile(file)).toContainEqual(
      expect.objectContaining({
        file,
        node: "$blueprint",
        rule: "yaml.parse",
      }),
    );
  });

  it("does not follow a referenced-file symlink outside the blueprint directory", () => {
    const source = passBlueprint().replace(
      'prompt: { inline: "Complete the request." }',
      "prompt: prompt.md",
    );
    const file = temporaryFile("nested/sample-a.yml", source);
    const outside = join(dirname(dirname(file)), "outside.md");
    writeFileSync(outside, "Outside");
    symlinkSync(outside, join(dirname(file), "prompt.md"));

    expect(
      validateBlueprintFile(file).some(
        (item) =>
          item.node === "first" &&
          item.rule === "reference.exists" &&
          item.message.includes("must stay beside"),
      ),
    ).toBe(true);
  });

  it("does not accept an absolute reference", () => {
    const file = temporaryFile("nested/sample-a.yml", passBlueprint());
    const prompt = join(dirname(file), "prompt.md");
    writeFileSync(prompt, "Prompt");
    writeFileSync(
      file,
      passBlueprint().replace(
        'prompt: { inline: "Complete the request." }',
        `prompt: ${prompt}`,
      ),
    );

    expect(
      validateBlueprintFile(file).some(
        (item) =>
          item.node === "first" &&
          item.rule === "reference.exists" &&
          item.message.includes("must stay beside"),
      ),
    ).toBe(true);
  });

  it("reports malformed node shapes as schema findings", () => {
    const file = temporaryFile(
      "sample-a.yml",
      "id: sample-a\nkind: helper\nnodes:\n  probe: null\n",
    );
    const findings = validateBlueprintFile(file);

    expect(findings).toContainEqual(
      expect.objectContaining({ rule: "blueprint.schema", node: "probe" }),
    );
    expect(findings.map((item) => item.rule)).not.toContain("input.path");
  });

  it("reports a non-string edge condition without throwing", () => {
    const source = `id: sample-a
kind: helper
nodes:
  child:
    uses: child-run
    params:
      blueprint: sample-child
  done:
    uses: notify
    params:
      channel: pushover
      title: { inline: "Done" }
edges:
  - from: child
    to: done
    when: 5
`;

    expect(
      validateBlueprintFile(temporaryFile("sample-a.yml", source)),
    ).toContainEqual(
      expect.objectContaining({
        node: "$blueprint",
        rule: "blueprint.schema",
      }),
    );
  });

  it("requires the blueprint id to match its filename", () => {
    const findings = validateBlueprintFile(
      temporaryFile("different.yml", passBlueprint()),
    );

    expect(findings).toContainEqual(
      expect.objectContaining({ rule: "blueprint.id", node: "$blueprint" }),
    );
  });

  it.each([
    ["object root", passBlueprint().replace("type: object", "type: string")],
    [
      "properties",
      passBlueprint().replace(
        "        properties:\n          value: { type: string }\n",
        "",
      ),
    ],
    [
      "valid JSON Schema",
      passBlueprint().replace(
        "value: { type: string }",
        "value: { type: impossible }",
      ),
    ],
  ])("requires handoff schema %s", (_constraint, source) => {
    expect(
      validateBlueprintFile(temporaryFile("sample-a.yml", source)).map(
        (item) => item.rule,
      ),
    ).toContain("handoff.schema");
  });

  it("validates a referenced handoff schema", () => {
    const source = passBlueprint().replace(
      "handoff:\n        type: object\n        description: Submit the result.\n        properties:\n          value: { type: string }",
      "handoff: handoff.yml",
    );
    const file = temporaryFile("sample-a.yml", source);
    writeFileSync(
      join(dirname(file), "handoff.yml"),
      "type: string\ndescription: Referenced result.\nproperties: {}\n",
    );

    expect(validateBlueprintFile(file)).toContainEqual(
      expect.objectContaining({
        file: join(dirname(file), "handoff.yml"),
        node: "first",
        rule: "handoff.schema",
        message: "root type must be object",
      }),
    );
  });

  it("resolves policy rules files", () => {
    const source = `id: sample-a
kind: helper
nodes:
  check:
    uses: policy
    params:
      rules: rules/missing.yml
`;

    expect(
      validateBlueprintFile(temporaryFile("sample-a.yml", source)),
    ).toContainEqual(
      expect.objectContaining({ node: "check", rule: "reference.exists" }),
    );
  });

  it("accepts a policy rule artifact with a conditional and fallback rule", () => {
    const { blueprint } = policyFixture(validPolicy);

    expect(validateBlueprintFile(blueprint)).toEqual([]);
  });

  it("reports an unknown policy rule property at its referenced file and location", () => {
    const { blueprint, policy } = policyFixture(
      validPolicy.replace(
        "    blueprint: selected-route",
        "    blueprint: selected-route\n    unexpected: true",
      ),
    );

    expect(validateBlueprintFile(blueprint)).toContainEqual(
      expect.objectContaining({
        file: policy,
        node: "/rules/0/unexpected",
        rule: "policy.schema",
      }),
    );
  });

  it("reports a missing required policy rule value at its referenced file and location", () => {
    const { blueprint, policy } = policyFixture(
      validPolicy.replace("  - id: preferred\n    when", "  - when"),
    );

    expect(validateBlueprintFile(blueprint)).toContainEqual(
      expect.objectContaining({
        file: policy,
        node: "/rules/0/id",
        rule: "policy.schema",
      }),
    );
  });

  it("reports an invalid policy condition shape at its referenced file and location", () => {
    const { blueprint, policy } = policyFixture(
      validPolicy.replace("when: category = 'Preferred'", "when: 4"),
    );

    expect(validateBlueprintFile(blueprint)).toContainEqual(
      expect.objectContaining({
        file: policy,
        node: "/rules/0/when",
        rule: "policy.schema",
      }),
    );
  });

  it("reports invalid policy JSONata at its referenced file and location", () => {
    const { blueprint, policy } = policyFixture(
      validPolicy.replace("category = 'Preferred'", "category ="),
    );

    expect(validateBlueprintFile(blueprint)).toContainEqual(
      expect.objectContaining({
        file: policy,
        node: "/rules/0/when",
        rule: "expression.jsonata",
      }),
    );
  });

  it.each([
    [
      "blueprint",
      "blueprint: selected-route",
      "blueprint: Invalid Route",
      "/rules/0/blueprint",
    ],
    [
      "input binding",
      'item: { from: "$" }',
      'item: { from: "" }',
      "/rules/0/inputs/item/from",
    ],
  ])(
    "reports an invalid policy %s while retaining a valid fallback rule",
    (_name, target, replacement, location) => {
      const { blueprint, policy } = policyFixture(
        validPolicy.replace(target, replacement),
      );

      expect(validateBlueprintFile(blueprint)).toContainEqual(
        expect.objectContaining({
          file: policy,
          node: location,
          rule: "policy.schema",
        }),
      );
    },
  );

  it("reports duplicate policy rule ids at the later rule", () => {
    const { blueprint, policy } = policyFixture(
      validPolicy.replace("id: fallback", "id: preferred"),
    );

    expect(validateBlueprintFile(blueprint)).toContainEqual({
      file: policy,
      node: "/rules/1/id",
      rule: "policy.rule-id",
      message: "Duplicate rule id: preferred",
    });
  });

  it("reports every policy rule after a fallback as unreachable", () => {
    const { blueprint, policy } = policyFixture(
      `${validPolicy}  - id: unreachable-a\n    when: category = 'Later A'\n    blueprint: later-route-a\n  - id: unreachable-b\n    when: category = 'Later B'\n    blueprint: later-route-b\n`,
    );

    expect(validateBlueprintFile(blueprint)).toEqual(
      expect.arrayContaining([
        {
          file: policy,
          node: "/rules/2",
          rule: "policy.fallback-order",
          message: "Rule cannot follow fallback at /rules/1",
        },
        {
          file: policy,
          node: "/rules/3",
          rule: "policy.fallback-order",
          message: "Rule cannot follow fallback at /rules/1",
        },
      ]),
    );
  });

  it("cites the first fallback for repeated fallback-order findings", () => {
    const { blueprint, policy } = policyFixture(`rules:
  - id: first-fallback
    blueprint: first-route
  - id: second-fallback
    blueprint: second-route
  - id: unreachable-a
    when: category = 'Later A'
    blueprint: later-route-a
  - id: unreachable-b
    when: category = 'Later B'
    blueprint: later-route-b
`);

    expect(validateBlueprintFile(blueprint)).toEqual([
      {
        file: policy,
        node: "/rules/1",
        rule: "policy.fallback-order",
        message: "Rule cannot follow fallback at /rules/0",
      },
      {
        file: policy,
        node: "/rules/2",
        rule: "policy.fallback-order",
        message: "Rule cannot follow fallback at /rules/0",
      },
      {
        file: policy,
        node: "/rules/3",
        rule: "policy.fallback-order",
        message: "Rule cannot follow fallback at /rules/0",
      },
    ]);
  });

  it("rejects a question role without a configured channel", () => {
    const source = `id: sample-a
kind: helper
nodes:
  ask:
    uses: question
    params:
      role: sample-role
      questions:
        - id: sample
          question: { inline: "Choose." }
`;

    expect(
      validateBlueprintFile(temporaryFile("sample-a.yml", source)),
    ).toContainEqual(
      expect.objectContaining({ node: "ask", rule: "heddle.question-role" }),
    );
  });

  it.each([
    [
      "action edge",
      passBlueprint().replace(
        "when: result.output.handoff or result.output.overridden or result.output.turnEnded",
        "action: continue\n    when: result.output.handoff or result.output.overridden or result.output.turnEnded",
      ),
      "heddle.no-action-edge",
    ],
    [
      "subflow",
      passBlueprint().replace("uses: notify", "uses: subflow"),
      "heddle.no-subflow",
    ],
    [
      "unhandled pass result",
      passBlueprint().replace(
        "result.output.handoff or result.output.overridden or result.output.turnEnded",
        "result.output.handoff",
      ),
      "heddle.unhandled-result",
    ],
    [
      "handoff without description",
      passBlueprint().replace(
        "description: Submit the result.",
        "description: ''",
      ),
      "handoff.schema",
    ],
    [
      "invalid JSONata",
      passBlueprint().replace(
        "result.output.handoff or result.output.overridden or result.output.turnEnded",
        "(",
      ),
      "expression.jsonata",
    ],
    [
      "missing template",
      passBlueprint().replace(
        'prompt: { inline: "Complete the request." }',
        "prompt: prompts/missing.md",
      ),
      "reference.exists",
    ],
  ])("rejects %s with %s", (_name, source, expectedRule) => {
    const file = temporaryFile("sample-a.yml", source);

    expect(validateBlueprintFile(file).map((item) => item.rule)).toContain(
      expectedRule,
    );
  });

  it.each([
    ["action-edge.yml", "heddle.no-action-edge"],
    ["subflow.yml", "heddle.no-subflow"],
    ["unhandled-pass-result.yml", "heddle.unhandled-result"],
    ["handoff-without-description.yml", "handoff.schema"],
    ["invalid-jsonata.yml", "expression.jsonata"],
    ["missing-template.yml", "reference.exists"],
  ])("keeps %s bound to %s in the negative corpus", (name, expectedRule) => {
    const file = resolve("test/fixtures/blueprints/negative", name);

    expect(validateBlueprintFile(file).map((item) => item.rule)).toContain(
      expectedRule,
    );
  });

  it("validates params through each node type's published schema", () => {
    const source = passBlueprint().replace(
      "channel: pushover",
      "channel: email",
    );
    const findings = validateBlueprintFile(
      temporaryFile("sample-a.yml", source),
    );

    expect(Object.keys(NODE_TYPE_REGISTRY)).toHaveLength(10);
    expect(findings).toContainEqual(
      expect.objectContaining({ node: "done", rule: "node.params" }),
    );
  });

  it.each(Object.keys(NODE_TYPE_REGISTRY))(
    "applies the %s registry params schema",
    (nodeType) => {
      const source = `id: sample-a
kind: helper
nodes:
  probe:
    uses: ${nodeType}
    params:
      unexpected: true
`;
      const findings = validateBlueprintFile(
        temporaryFile("sample-a.yml", source),
      );

      expect(findings).toContainEqual(
        expect.objectContaining({ node: "probe", rule: "node.params" }),
      );
    },
  );

  it("keeps the live requires.issue check behind its flag", () => {
    const source = passBlueprint().replace(
      "nodes:",
      "requires:\n  issue:\n    labels: [sample]\nnodes:",
    );
    const file = temporaryFile("sample-a.yml", source);

    expect(validateBlueprintFile(file)).toEqual([]);
    expect(
      validateBlueprintFile(file, { checkRequiresIssue: true }).some(
        (item) =>
          item.rule === "requires.issue.live" &&
          item.message.includes("not checked"),
      ),
    ).toBe(true);
  });

  it("checks stage names only at the flagged live boundary", () => {
    const file = resolve(
      "fixtures/blueprints/recipe-pipeline/recipe-pipeline.yml",
    );

    expect(validateBlueprintFile(file)).toEqual([]);
    expect(
      validateBlueprintFile(file, { checkRequiresIssue: true }),
    ).toContainEqual(
      expect.objectContaining({
        node: "draft",
        rule: "requires.issue.stage-name",
        message:
          "not checked: configure a bound project for live stage-name validation",
      }),
    );
  });

  it("rejects a directory with no blueprint candidates", () => {
    const directory = mkdtempSync(join(tmpdir(), "heddle-blueprints-empty-"));
    temporaryDirectories.push(directory);

    expect(validateBlueprintPath(directory)).toContainEqual(
      expect.objectContaining({
        file: directory,
        node: "$blueprint",
        rule: "input.path",
      }),
    );
  });

  it("requires turnEnded routing for every pass policy start", () => {
    const source = passBlueprint().replace(" or result.output.turnEnded", "");

    expect(
      validateBlueprintFile(temporaryFile("sample-a.yml", source)),
    ).toContainEqual(
      expect.objectContaining({
        node: "first",
        rule: "heddle.unhandled-result",
        message: "Result is not handled: turnEnded",
      }),
    );
  });

  it("rejects a statically unknown context root", () => {
    const source = `id: sample-a
kind: helper
nodes:
  child:
    uses: child-run
    params:
      blueprint: sample-child
      inputs:
        value: { from: absent.value }
`;
    const findings = validateBlueprintFile(
      temporaryFile("sample-a.yml", source),
    );

    expect(findings).toContainEqual(
      expect.objectContaining({
        node: "child",
        rule: "heddle.context-key",
        message: "Context key cannot be provided: absent",
      }),
    );
  });

  it("rejects context from a node that cannot precede the consumer", () => {
    const source = `id: sample-a
kind: helper
nodes:
  first:
    uses: notify
    params:
      channel: pushover
      title: { inline: "First" }
      url: { from: later.receipt }
  later:
    uses: notify
    params:
      channel: pushover
      title: { inline: "Later" }
edges:
  - from: first
    to: later
`;
    const findings = validateBlueprintFile(
      temporaryFile("sample-a.yml", source),
    );

    expect(findings).toContainEqual(
      expect.objectContaining({
        node: "first",
        rule: "heddle.context-key",
        message: "Context key cannot be provided: later",
      }),
    );
  });
});
