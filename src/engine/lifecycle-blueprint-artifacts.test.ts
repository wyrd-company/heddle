// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  validateBlueprintRepository,
  validateBlueprintToolRegistry,
} from "./blueprint-repository-validation.js";
import { validateBlueprint } from "./blueprint.js";
import { deliveryBlueprintFixture } from "./lifecycle-blueprint.test-support.js";
import type { LifecycleBlueprint, LifecycleEffect } from "./types.js";

const roots: string[] = [];
const execute = promisify(execFile);

const sampleHandoffTemplate = "# {{ task.title }}\n";
const sampleTodoTemplate = `${JSON.stringify(
  { items: [{ id: "orient", text: "Orient on {{task.title}}" }] },
  null,
  2,
)}\n`;
const sampleTheme = `$schema: https://wyrd.company/heddle/agent-name-theme.schema.json
relationships:
  implements: heddle
kind: team
leader: sample-lead
companions: [sample-companion]
allies: [sample-ally]
antagonists: [sample-antagonist]
neutrals: [sample-neutral]
`;
const artifact = (commitSha = "a".repeat(40)) => ({
  $schema: "https://wyrd.company/heddle/lifecycle-blueprint.schema.json",
  relationships: {
    implements: "heddle",
    uses: ["sample-checklist", "sample-handoff"],
  },
  nodes: [
    { id: "prepare", uses: "prepare" },
    {
      handoff: "standard",
      "handoff-template": {
        commitSha,
        path: "handoff-templates/sample-handoff.md",
      },
      id: "inspect",
      tools: ["advance"],
      "todo-template": "sample-checklist",
      uses: "wait",
    },
    { id: "finish", uses: "finish" },
  ],
  edges: [
    { source: "prepare", target: "inspect" },
    {
      condition: "result.output.dispositions.complete",
      description: "Complete the sample inspection",
      disposition: "complete",
      source: "inspect",
      target: "finish",
    },
  ],
});

const deliveryArtifact = (artifactId: "standard-delivery" | "trivial") => ({
  $schema: "https://wyrd.company/heddle/lifecycle-blueprint.schema.json",
  relationships: {
    implements: "heddle",
    uses: [
      "standard-delivery-implement",
      "standard-delivery-review",
      "standard-delivery-remediate",
      ...(artifactId === "standard-delivery"
        ? ["standard-delivery-retrospective"]
        : []),
      "standard",
      "remediation",
    ],
  },
  ...deliveryBlueprintFixture(artifactId),
});

const repository = async (
  value?: unknown,
  artifactId = "sample-process",
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "heddle-blueprint-validation-"));
  roots.push(root);
  await mkdir(join(root, "blueprints"));
  await mkdir(join(root, "themes"));
  await writeFile(join(root, "themes", "sample-team.yml"), sampleTheme);
  await mkdir(join(root, "handoff-templates"));
  await writeFile(
    join(root, "handoff-templates", "sample-handoff.md"),
    sampleHandoffTemplate,
  );
  await mkdir(join(root, "todo-templates"));
  await writeFile(
    join(root, "todo-templates", "sample-checklist.json"),
    sampleTodoTemplate,
  );
  await execute("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: root,
  });
  await execute("git", ["add", "handoff-templates", "todo-templates"], {
    cwd: root,
  });
  await execute(
    "git",
    [
      "-c",
      "user.name=Sample User",
      "-c",
      "user.email=sample@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "add sample templates",
    ],
    { cwd: root },
  );
  const commitSha = (
    await execute("git", ["rev-parse", "HEAD"], { cwd: root })
  ).stdout.trim();
  await writeFile(
    join(root, "blueprints", `${artifactId}.json`),
    `${JSON.stringify(value ?? artifact(commitSha), null, 2)}\n`,
  );
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("organization lifecycle blueprint artifacts", () => {
  it("keeps authored blueprints outside the Heddle source repository", async () => {
    await expect(
      lstat(join(process.cwd(), "blueprints")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates a generated repository with the authoritative schema and interpreter", async () => {
    await expect(
      validateBlueprintRepository(await repository()),
    ).resolves.toEqual(["sample-process"]);
  });

  it("rejects schema-invalid artifacts", async () => {
    const invalid = artifact() as Record<string, unknown>;
    invalid["id"] = "authored-id";
    await expect(
      validateBlueprintRepository(await repository(invalid)),
    ).rejects.toThrow("violates the lifecycle schema");
  });

  it("rejects a non-string stage skill through the lifecycle schema", async () => {
    const invalid = artifact();
    (invalid.nodes[1] as Record<string, unknown>)["skills"] = [17];

    await expect(
      validateBlueprintRepository(await repository(invalid)),
    ).rejects.toThrow(/violates the lifecycle schema[\s\S]*"keyword":"type"/);
  });

  it("rejects duplicate stage skills through the lifecycle schema", async () => {
    const invalid = artifact();
    (invalid.nodes[1] as Record<string, unknown>)["skills"] = [
      "evidence-review",
      "evidence-review",
    ];

    await expect(
      validateBlueprintRepository(await repository(invalid)),
    ).rejects.toThrow(
      /violates the lifecycle schema[\s\S]*"keyword":"uniqueItems"/,
    );
  });

  it("rejects a stage skill longer than 64 characters through the lifecycle schema", async () => {
    const invalid = artifact();
    (invalid.nodes[1] as Record<string, unknown>)["skills"] = ["a".repeat(65)];

    await expect(
      validateBlueprintRepository(await repository(invalid)),
    ).rejects.toThrow(
      /violates the lifecycle schema[\s\S]*"keyword":"maxLength"/,
    );
  });

  it("accepts provider alias and runtime mode on an agent wait node", async () => {
    const root = await repository();
    const valid = JSON.parse(
      await readFile(join(root, "blueprints/sample-process.json"), "utf8"),
    ) as ReturnType<typeof artifact>;
    const wait = valid.nodes[1] as Record<string, unknown>;
    wait["provider-alias"] = "reviewer";
    wait["runtime-mode"] = "full-access";
    await writeFile(
      join(root, "blueprints/sample-process.json"),
      `${JSON.stringify(valid, null, 2)}\n`,
    );

    await expect(validateBlueprintRepository(root)).resolves.toEqual([
      "sample-process",
    ]);
  });

  it("accepts an agent-name list on an agent wait node", async () => {
    const root = await repository();
    const valid = JSON.parse(
      await readFile(join(root, "blueprints/sample-process.json"), "utf8"),
    ) as ReturnType<typeof artifact>;
    const wait = valid.nodes[1] as Record<string, unknown>;
    wait["assign-agent-name"] = "allies";
    await writeFile(
      join(root, "blueprints/sample-process.json"),
      `${JSON.stringify(valid, null, 2)}\n`,
    );

    await expect(validateBlueprintRepository(root)).resolves.toEqual([
      "sample-process",
    ]);
  });

  it("rejects an unknown agent-name list through the lifecycle schema", async () => {
    const invalid = artifact();
    (invalid.nodes[1] as Record<string, unknown>)["assign-agent-name"] =
      "unknown-list";

    await expect(
      validateBlueprintRepository(await repository(invalid)),
    ).rejects.toThrow("violates the lifecycle schema");
  });

  it.each([
    ["provider-alias", null],
    ["provider-alias", ""],
    ["provider-alias", "Not-Valid"],
    ["provider-alias", "a".repeat(65)],
    ["runtime-mode", "unrestricted"],
  ])(
    "rejects an invalid wait-node %s through the lifecycle schema",
    async (field, value) => {
      const invalid = artifact();
      (invalid.nodes[1] as Record<string, unknown>)[field] = value;

      await expect(
        validateBlueprintRepository(await repository(invalid)),
      ).rejects.toThrow("violates the lifecycle schema");
    },
  );

  it.each(["provider-alias", "runtime-mode"])(
    "rejects mechanical-node %s through the lifecycle schema",
    async (field) => {
      const invalid = artifact();
      (invalid.nodes[0] as Record<string, unknown>)[field] =
        field === "provider-alias" ? "primary" : "auto";

      await expect(
        validateBlueprintRepository(await repository(invalid)),
      ).rejects.toThrow("violates the lifecycle schema");
    },
  );

  it("rejects interpreter-invalid mechanical-node agent-name assignment", () => {
    const invalid = deliveryBlueprintFixture("trivial");
    (invalid.nodes[0] as Record<string, unknown>)["assign-agent-name"] =
      "allies";
    const blueprint = { ...invalid, id: "trivial" } as LifecycleBlueprint;
    const effects = Object.fromEntries(
      blueprint.nodes
        .filter(({ uses }) => uses !== "wait")
        .map(({ uses }) => [uses, async () => ({})]),
    ) as Record<string, LifecycleEffect>;

    expect(() => validateBlueprint(blueprint, effects)).toThrow(
      "must not assign an agent name",
    );
  });

  it.each(["provider-alias", "runtime-mode"])(
    "rejects interpreter-invalid mechanical-node %s",
    (field) => {
      const invalid = deliveryBlueprintFixture("trivial");
      (invalid.nodes[0] as Record<string, unknown>)[field] =
        field === "provider-alias" ? "primary" : "auto";
      const blueprint = { ...invalid, id: "trivial" } as LifecycleBlueprint;
      const effects = Object.fromEntries(
        blueprint.nodes
          .filter(({ uses }) => uses !== "wait")
          .map(({ uses }) => [uses, async () => ({})]),
      ) as Record<string, LifecycleEffect>;

      expect(() => validateBlueprint(blueprint, effects)).toThrow(
        "must not declare session selection",
      );
    },
  );

  it.each([
    ["provider-alias", "Not-Valid", "provider-alias"],
    ["runtime-mode", "unrestricted", "runtime-mode"],
  ])("rejects interpreter-invalid wait-node %s", (field, value, message) => {
    const invalid = deliveryBlueprintFixture("trivial");
    (
      invalid.nodes.find(({ id }) => id === "implement") as Record<
        string,
        unknown
      >
    )[field] = value;
    const blueprint = { ...invalid, id: "trivial" } as LifecycleBlueprint;
    const effects = Object.fromEntries(
      blueprint.nodes
        .filter(({ uses }) => uses !== "wait")
        .map(({ uses }) => [uses, async () => ({})]),
    ) as Record<string, LifecycleEffect>;

    expect(() => validateBlueprint(blueprint, effects)).toThrow(message);
  });

  it("rejects the removed handoff blobHash schema shape", async () => {
    const invalid = artifact();
    (invalid.nodes[1] as Record<string, unknown>)["handoff-template"] = {
      blobHash: "a".repeat(40),
      path: "handoff-templates/sample-handoff.md",
    };

    await expect(
      validateBlueprintRepository(await repository(invalid)),
    ).rejects.toThrow(/commitSha[\s\S]*blobHash/);
  });

  it("rejects interpreter-invalid graphs", async () => {
    const invalid = artifact();
    invalid.edges = [];
    await expect(
      validateBlueprintRepository(await repository(invalid)),
    ).rejects.toThrow('Wait node "inspect" has no disposition edges');
  });

  it("accepts an explicit producer output contract on a disposition", async () => {
    const root = await repository();
    const valid = JSON.parse(
      await readFile(join(root, "blueprints/sample-process.json"), "utf8"),
    ) as ReturnType<typeof artifact>;
    valid.edges[1] = {
      ...valid.edges[1]!,
      "output-contract": "incident-diagnosis",
    };
    await writeFile(
      join(root, "blueprints/sample-process.json"),
      `${JSON.stringify(valid, null, 2)}\n`,
    );

    await expect(validateBlueprintRepository(root)).resolves.toEqual([
      "sample-process",
    ]);
  });

  it("accepts explicit review findings when rejection returns to a standard handoff", async () => {
    const root = await repository();
    const valid = JSON.parse(
      await readFile(join(root, "blueprints/sample-process.json"), "utf8"),
    ) as ReturnType<typeof artifact>;
    valid.edges[1] = {
      ...valid.edges[1]!,
      "output-contract": "review-findings",
    };
    await writeFile(
      join(root, "blueprints/sample-process.json"),
      `${JSON.stringify(valid, null, 2)}\n`,
    );

    await expect(validateBlueprintRepository(root)).resolves.toEqual([
      "sample-process",
    ]);
  });

  it("rejects a blueprint that omits a mechanical node board status", () => {
    const invalid = deliveryBlueprintFixture("standard-delivery");
    delete invalid["board-statuses"]!.merge;
    const blueprint = {
      ...invalid,
      id: "standard-delivery",
    } as LifecycleBlueprint;
    const effects = Object.fromEntries(
      blueprint.nodes
        .filter(({ uses }) => uses !== "wait")
        .map(({ uses }) => [uses, async () => ({})]),
    ) as Record<string, LifecycleEffect>;

    expect(() => validateBlueprint(blueprint, effects)).toThrow(
      'Blueprint board-statuses is missing mechanical node use "merge"',
    );
  });

  it("rejects a blueprint board-statuses key that is not a mechanical node use", () => {
    const invalid = deliveryBlueprintFixture("standard-delivery");
    (invalid["board-statuses"] as Record<string, string>)["publish"] = "done";
    const blueprint = {
      ...invalid,
      id: "standard-delivery",
    } as LifecycleBlueprint;
    const effects = Object.fromEntries(
      blueprint.nodes
        .filter(({ uses }) => uses !== "wait")
        .map(({ uses }) => [uses, async () => ({})]),
    ) as Record<string, LifecycleEffect>;

    expect(() => validateBlueprint(blueprint, effects)).toThrow(
      'Blueprint board-statuses names unknown mechanical node use "publish"',
    );
  });

  it("rejects an empty board status through the lifecycle schema", async () => {
    const invalid = deliveryArtifact("trivial");
    invalid["board-statuses"]!.finalize = "";

    await expect(
      validateBlueprintRepository(await repository(invalid, "trivial")),
    ).rejects.toThrow("violates the lifecycle schema");
  });

  it("names the blueprint, node, and unresolved tool in registry failures", async () => {
    const invalid = artifact();
    (invalid.nodes[1] as { tools: string[] }).tools.push("missing_tool");

    await expect(
      validateBlueprintToolRegistry(
        await repository(invalid),
        new Set(["advance"]),
      ),
    ).rejects.toThrow(
      "Blueprint 'sample-process' node 'inspect' declares MCP tool 'missing_tool' that is not registered",
    );
  });

  it("checks the tool registry without moving other blueprint validation boundaries", async () => {
    const partial = artifact() as Record<string, unknown>;
    delete partial["$schema"];
    delete partial["relationships"];
    const root = await repository(partial);

    await expect(
      validateBlueprintToolRegistry(root, new Set(["advance"])),
    ).resolves.toBeUndefined();
    (partial["nodes"] as Array<{ tools?: string[] }>)[1]!.tools!.push(
      "missing_tool",
    );
    await writeFile(
      join(root, "blueprints/sample-process.json"),
      `${JSON.stringify(partial)}\n`,
    );
    await expect(
      validateBlueprintToolRegistry(root, new Set(["advance"])),
    ).rejects.toThrow(
      "Blueprint 'sample-process' node 'inspect' declares MCP tool 'missing_tool' that is not registered",
    );
  });

  it("binds declared relationships to todo and handoff template artifacts", async () => {
    const invalid = artifact();
    invalid.relationships.uses = ["sample-checklist"];
    await expect(
      validateBlueprintRepository(await repository(invalid)),
    ).rejects.toThrow("relationships must name its bound artifacts");
  });

  it("binds declared relationships to stage skill artifacts", async () => {
    const invalid = artifact();
    (invalid.nodes[1] as Record<string, unknown>)["skills"] = [
      "evidence-review",
    ];

    await expect(
      validateBlueprintRepository(await repository(invalid)),
    ).rejects.toThrow("relationships must name its bound artifacts");
  });

  it("resolves a pinned handoff template after its working-tree path is removed", async () => {
    const root = await repository();
    await rm(join(root, "handoff-templates", "sample-handoff.md"));
    await expect(validateBlueprintRepository(root)).resolves.toEqual([
      "sample-process",
    ]);
  });

  it("rejects an unavailable pinned handoff template commit", async () => {
    const invalid = artifact();
    (invalid.nodes[1] as { "handoff-template": { commitSha: string } })[
      "handoff-template"
    ].commitSha = "b".repeat(40);
    await expect(
      validateBlueprintRepository(await repository(invalid)),
    ).rejects.toThrow(
      `pins unavailable handoff template commit ${"b".repeat(40)}`,
    );
  });

  it("ignores changed working-tree template bytes during pin validation", async () => {
    const root = await repository();
    await writeFile(
      join(root, "handoff-templates", "sample-handoff.md"),
      "Changed {{ task.title }}\n",
    );

    await expect(validateBlueprintRepository(root)).resolves.toEqual([
      "sample-process",
    ]);
  });

  it("rejects a pinned handoff template commit SHA whose length is not a Git object ID", async () => {
    const invalid = artifact();
    (invalid.nodes[1] as { "handoff-template": { commitSha: string } })[
      "handoff-template"
    ].commitSha = "a".repeat(41);

    await expect(
      validateBlueprintRepository(await repository(invalid)),
    ).rejects.toThrow(/must match pattern.*40.*64/);
  });

  it("rejects a handoff template path unavailable at its pinned commit", async () => {
    const root = await repository();
    const commitSha = (
      await execute("git", ["rev-parse", "HEAD"], { cwd: root })
    ).stdout.trim();
    const invalid = artifact(commitSha);
    invalid.relationships.uses = ["missing", "sample-checklist"];
    invalid.nodes[1]!["handoff-template"]!.path =
      "handoff-templates/missing.md";
    await writeFile(
      join(root, "blueprints", "sample-process.json"),
      `${JSON.stringify(invalid, null, 2)}\n`,
    );

    await expect(validateBlueprintRepository(root)).rejects.toThrow(
      `pins handoff template 'handoff-templates/missing.md' that is unavailable at commit ${commitSha}`,
    );
  });

  it("rejects a named todo template with no repository artifact", async () => {
    const root = await repository();
    await rm(join(root, "todo-templates", "sample-checklist.json"));
    await expect(validateBlueprintRepository(root)).rejects.toThrow(
      "names todo template 'sample-checklist' that has no artifact in todo-templates/",
    );
  });

  it.each(["standard-delivery", "trivial"] as const)(
    "rejects inconsistent %s wait-stage handoff metadata",
    async (artifactId) => {
      const invalid = deliveryArtifact(artifactId);
      invalid.nodes.find(({ id }) => id === "remediate")!.handoff = "standard";

      await expect(
        validateBlueprintRepository(await repository(invalid, artifactId)),
      ).rejects.toThrow("inconsistent delivery handoff metadata");
    },
  );

  it.each(["standard-delivery", "trivial"] as const)(
    "rejects a %s merge reached by the reject disposition",
    async (artifactId) => {
      const invalid = deliveryArtifact(artifactId);
      invalid.edges.find(
        ({ disposition }) => disposition === "reject",
      )!.target = "merge";
      const blueprint = { ...invalid, id: artifactId } as LifecycleBlueprint;
      const effects = Object.fromEntries(
        blueprint.nodes
          .filter(({ uses }) => uses !== "wait")
          .map(({ uses }) => [uses, async () => ({})]),
      ) as Record<string, LifecycleEffect>;

      expect(() => validateBlueprint(blueprint, effects)).toThrow(
        'Merge node "merge" must be reached only from a review wait node approve disposition',
      );
    },
  );

  it.each(["standard-delivery", "trivial"] as const)(
    "rejects a %s merge approved by a wait without a current review snapshot",
    async (artifactId) => {
      const invalid = deliveryArtifact(artifactId);
      invalid.edges.find(
        ({ disposition }) => disposition === "approve",
      )!.source = "implement";
      const blueprint = { ...invalid, id: artifactId } as LifecycleBlueprint;
      const effects = Object.fromEntries(
        blueprint.nodes
          .filter(({ uses }) => uses !== "wait")
          .map(({ uses }) => [uses, async () => ({})]),
      ) as Record<string, LifecycleEffect>;

      expect(() => validateBlueprint(blueprint, effects)).toThrow(
        'Merge node "merge" must be reached only from a review wait node approve disposition',
      );
    },
  );
});
