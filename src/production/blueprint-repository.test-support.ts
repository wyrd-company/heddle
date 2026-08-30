// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { SqlitePersistence } from "../persistence/index.js";
import { OrganizationBlueprintRepository } from "./blueprint-repository.js";
import { DurableAttentionQueue } from "./durable-adapters.js";

export const executeGit = promisify(execFile);

export const sampleBlueprintArtifact = () => ({
  $schema: "https://wyrd.company/heddle/lifecycle-blueprint.schema.json",
  relationships: { implements: "heddle", uses: ["sample-checklist"] },
  nodes: [
    { id: "prepare", uses: "prepare" },
    {
      handoff: "standard",
      "handoff-template": {
        blobHash: "a".repeat(40),
        path: "handoff-templates/sample.md",
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
      description: "Continue after inspection",
      disposition: "complete",
      source: "inspect",
      target: "finish",
    },
  ],
});

export type BlueprintRepositoryFixture = {
  attention: DurableAttentionQueue;
  cleanup(): Promise<void>;
  persistence: SqlitePersistence;
  remoteRoot: string;
  repository: OrganizationBlueprintRepository;
  repositoryRoot: string;
  root: string;
};

export const prepareBlueprintRepositoryFixture =
  async (): Promise<BlueprintRepositoryFixture> => {
    const root = await mkdtemp(join(tmpdir(), "heddle-blueprint-repository-"));
    const repositoryRoot = join(root, "organization-blueprints");
    const remoteRoot = join(root, "origin.git");
    await mkdir(join(repositoryRoot, "blueprints"), { recursive: true });
    await writeFile(
      join(repositoryRoot, "blueprints", "sample-process.json"),
      `${JSON.stringify(sampleBlueprintArtifact(), null, 2)}\n`,
    );
    await executeGit("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: repositoryRoot,
    });
    await executeGit("git", ["add", "blueprints"], { cwd: repositoryRoot });
    await executeGit(
      "git",
      [
        "-c",
        "user.name=Fixture User",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Add sample blueprint",
      ],
      { cwd: repositoryRoot },
    );
    await executeGit("git", ["init", "--quiet", "--bare", remoteRoot], {
      cwd: root,
    });
    await executeGit("git", ["remote", "add", "origin", remoteRoot], {
      cwd: repositoryRoot,
    });
    await executeGit(
      "git",
      ["push", "--quiet", "--set-upstream", "origin", "main"],
      { cwd: repositoryRoot },
    );
    await executeGit("git", ["config", "user.name", "Fixture User"], {
      cwd: repositoryRoot,
    });
    await executeGit(
      "git",
      ["config", "user.email", "fixture@example.invalid"],
      { cwd: repositoryRoot },
    );
    const persistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    const attention = new DurableAttentionQueue(persistence);
    const repository = new OrganizationBlueprintRepository(
      repositoryRoot,
      persistence,
      attention,
    );
    return {
      attention,
      cleanup: async () => {
        persistence.close();
        await rm(root, { force: true, recursive: true });
      },
      persistence,
      remoteRoot,
      repository,
      repositoryRoot,
      root,
    };
  };
