// ---
// relationships:
//   verifies: heddle
// ---

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import {
  validateBlueprintRepository,
  validateBlueprintToolRegistry,
} from "./blueprint-repository-validation.js";
import { validateBlueprint } from "./blueprint.js";
import { deliveryBlueprintFixture } from "./lifecycle-blueprint.test-support.js";
import type { LifecycleBlueprint, LifecycleEffect } from "./types.js";

const roots: string[] = [];

const sampleHandoffTemplate = "# {{ task.title }}\n";
const sampleTodoTemplate = `${JSON.stringify(
  { items: [{ id: "orient", text: "Orient on {{task.title}}" }] },
  null,
  2,
)}\n`;
const sampleHandoffBlobHash = createHash("sha1")
  .update(`blob ${Buffer.byteLength(sampleHandoffTemplate)}\0`)
  .update(sampleHandoffTemplate)
  .digest("hex");

const artifact = () => ({
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
        blobHash: sampleHandoffBlobHash,
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
  value: unknown = artifact(),
  artifactId = "sample-process",
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "heddle-blueprint-validation-"));
  roots.push(root);
  await mkdir(join(root, "blueprints"));
  await writeFile(
    join(root, "blueprints", `${artifactId}.json`),
    `${JSON.stringify(value, null, 2)}\n`,
  );
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

  it("rejects interpreter-invalid graphs", async () => {
    const invalid = artifact();
    invalid.edges = [];
    await expect(
      validateBlueprintRepository(await repository(invalid)),
    ).rejects.toThrow('Wait node "inspect" has no disposition edges');
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
    ).rejects.toThrow("relationships must name its template artifacts");
  });

  it("rejects a pinned handoff template path with no repository artifact", async () => {
    const root = await repository();
    await rm(join(root, "handoff-templates", "sample-handoff.md"));
    await expect(validateBlueprintRepository(root)).rejects.toThrow(
      "pins handoff template 'handoff-templates/sample-handoff.md' that is not in the repository",
    );
  });

  it("rejects a pinned handoff template blob hash that does not match the artifact", async () => {
    const invalid = artifact();
    (invalid.nodes[1] as { "handoff-template": { blobHash: string } })[
      "handoff-template"
    ].blobHash = "b".repeat(40);
    await expect(
      validateBlueprintRepository(await repository(invalid)),
    ).rejects.toThrow(
      "pins handoff template blob " +
        `${"b".repeat(40)} that does not match 'handoff-templates/sample-handoff.md'`,
    );
  });

  it("rejects a pinned handoff template blob hash whose length is not a Git object ID", async () => {
    const invalid = artifact();
    (invalid.nodes[1] as { "handoff-template": { blobHash: string } })[
      "handoff-template"
    ].blobHash = "a".repeat(41);

    await expect(
      validateBlueprintRepository(await repository(invalid)),
    ).rejects.toThrow("pins an invalid handoff template blob hash");
  });

  it("reports a non-absence handoff template read failure without relabeling it as missing", async () => {
    const root = await repository();
    const path = join(root, "handoff-templates", "sample-handoff.md");
    await rm(path);
    await mkdir(path);

    await expect(validateBlueprintRepository(root)).rejects.toThrow(
      "could not read handoff template 'handoff-templates/sample-handoff.md': EISDIR",
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
