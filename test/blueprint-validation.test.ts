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

import {
  deriveFlowcraftBlueprint,
  lintDerivedBlueprint,
  loadBlueprint,
  loadValidatedBlueprint,
  NODE_TYPE_REGISTRY,
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
    when: result.output.handoff or result.output.overridden
${overrides}`;
}

describe("blueprint loading", () => {
  it("preserves every source byte on an unchanged save", () => {
    const file = resolve(
      "fixtures/blueprints/recipe-pipeline/recipe-pipeline.yml",
    );
    const loaded = loadBlueprint(file);

    expect(saveBlueprint(loaded)).toBe(readFileSync(file, "utf8"));
  });

  it("offers the full check chain as the service load boundary", () => {
    const valid = temporaryFile("sample-a.yml", passBlueprint());
    const invalid = temporaryFile(
      "sample-a.yml",
      passBlueprint().replace(
        "result.output.handoff or result.output.overridden",
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
        condition: "result.output.handoff or result.output.overridden",
      },
    ]);
    expect(derived.edges.every((edge) => edge.action === undefined)).toBe(true);
  });
});

describe("validation chain", () => {
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
      "  - from: first\n    to: done\n    when: result.output.handoff or result.output.overridden",
      "  - from: first\n    to: done\n    when: result.output.handoff or result.output.overridden\n  - from: done\n    to: first",
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

  it("validates a directory while ignoring referenced schema documents", () => {
    const file = temporaryFile("sample-a/sample-a.yml", passBlueprint());
    writeFileSync(
      join(dirname(file), "contract.yml"),
      "type: object\ndescription: A contract.\nproperties: {}\n",
    );

    expect(validateBlueprintPath(dirname(dirname(file)))).toEqual([]);
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
      passBlueprint().replace("type: object", "type: impossible"),
    ],
  ])("requires handoff schema %s", (_constraint, source) => {
    expect(
      validateBlueprintFile(temporaryFile("sample-a.yml", source)).map(
        (item) => item.rule,
      ),
    ).toContain("handoff.schema");
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
        "when: result.output.handoff or result.output.overridden",
        "action: continue\n    when: result.output.handoff or result.output.overridden",
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
        "result.output.handoff or result.output.overridden",
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
        "result.output.handoff or result.output.overridden",
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
});
