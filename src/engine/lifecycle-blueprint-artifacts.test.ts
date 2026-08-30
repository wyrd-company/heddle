// ---
// relationships:
//   verifies: heddle
// ---

import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import { validateBlueprintRepository } from "./blueprint-repository-validation.js";

const roots: string[] = [];

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
        blobHash: "a".repeat(40),
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

const repository = async (value: unknown = artifact()): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "heddle-blueprint-validation-"));
  roots.push(root);
  await mkdir(join(root, "blueprints"));
  await writeFile(
    join(root, "blueprints", "sample-process.json"),
    `${JSON.stringify(value, null, 2)}\n`,
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

  it("binds declared relationships to todo and handoff template artifacts", async () => {
    const invalid = artifact();
    invalid.relationships.uses = ["sample-checklist"];
    await expect(
      validateBlueprintRepository(await repository(invalid)),
    ).rejects.toThrow("relationships must name its template artifacts");
  });
});
