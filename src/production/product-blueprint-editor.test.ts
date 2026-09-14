// ---
// relationships:
//   verifies: heddle
// ---

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqlitePersistence } from "../persistence/index.js";
import {
  BlueprintPushError,
  OrganizationBlueprintRepository,
} from "./blueprint-repository.js";
import {
  prepareBlueprintRepositoryFixture,
  type BlueprintRepositoryFixture,
  executeGit,
} from "./blueprint-repository.test-support.js";
import { OrganizationBlueprintArtifactEditor } from "./product-blueprint-editor.js";
import { DurableAttentionQueue } from "./durable-adapters.js";

describe("organization blueprint artifact editor", () => {
  let fixture: BlueprintRepositoryFixture | undefined;
  let workerPersistence: SqlitePersistence | undefined;

  afterEach(async () => {
    workerPersistence?.close();
    workerPersistence = undefined;
    await fixture?.cleanup();
    fixture = undefined;
  });

  const editor = async () => {
    fixture = await prepareBlueprintRepositoryFixture();
    return new OrganizationBlueprintArtifactEditor({
      effects: {
        finish: async () => ({}),
        prepare: async () => ({}),
      },
      repository: fixture.repository,
    });
  };

  it("edits and pushes only through the worker synchronization checkout", async () => {
    fixture = await prepareBlueprintRepositoryFixture();
    const pushRemote = join(fixture.root, "worker-push.git");
    await executeGit("git", ["init", "--quiet", "--bare", pushRemote], {
      cwd: fixture.root,
    });
    await executeGit("git", ["push", "--quiet", pushRemote, "main"], {
      cwd: fixture.repositoryRoot,
    });
    await executeGit(
      "git",
      ["remote", "set-url", "--push", "origin", pushRemote],
      { cwd: fixture.repositoryRoot },
    );
    const sourceBytes = await readFile(
      join(fixture.repositoryRoot, "blueprints", "sample-process.json"),
      "utf8",
    );
    const workerRoot = join(fixture.root, "worker", "blueprints");
    workerPersistence = new SqlitePersistence({
      stateDirectory: join(fixture.root, "worker-state"),
    });
    const repository = new OrganizationBlueprintRepository(
      workerRoot,
      workerPersistence,
      new DurableAttentionQueue(workerPersistence),
      fixture.repositoryRoot,
    );
    await repository.synchronize();
    expect(
      (
        await executeGit("git", ["config", "--local", "--get", "user.name"], {
          cwd: workerRoot,
        })
      ).stdout.trim(),
    ).toBe("Fixture User");
    expect(
      (
        await executeGit("git", ["config", "--local", "--get", "user.email"], {
          cwd: workerRoot,
        })
      ).stdout.trim(),
    ).toBe("fixture@example.invalid");
    const subject = new OrganizationBlueprintArtifactEditor({
      effects: {
        finish: async () => ({}),
        prepare: async () => ({}),
      },
      repository,
    });
    const loaded = await subject.load("sample-process");

    await subject.save({
      artifactId: "sample-process",
      edges: loaded.blueprint.edges,
      expectedBlobHash: loaded.blobHash,
      nodes: loaded.blueprint.nodes,
      positions: { inspect: { x: 360, y: 240 } },
    });

    expect(
      await readFile(
        join(workerRoot, "blueprints", "sample-process.json"),
        "utf8",
      ),
    ).toContain('"x": 360');
    expect(
      await readFile(
        join(fixture.repositoryRoot, "blueprints", "sample-process.json"),
        "utf8",
      ),
    ).toBe(sourceBytes);
    expect(
      (
        await executeGit(
          "git",
          ["show", "main:blueprints/sample-process.json"],
          { cwd: pushRemote },
        )
      ).stdout,
    ).toContain('"x": 360');
    expect(
      (
        await executeGit(
          "git",
          ["show", "main:blueprints/sample-process.json"],
          { cwd: fixture.remoteRoot },
        )
      ).stdout,
    ).not.toContain('"x": 360');
  });

  it("commits and pushes one validated edit through the central repository", async () => {
    const subject = await editor();
    const otherRemote = join(fixture!.root, "other.git");
    await executeGit("git", ["init", "--quiet", "--bare", otherRemote], {
      cwd: fixture!.root,
    });
    await executeGit("git", ["remote", "add", "other", otherRemote], {
      cwd: fixture!.repositoryRoot,
    });
    await executeGit("git", ["config", "remote.pushDefault", "other"], {
      cwd: fixture!.repositoryRoot,
    });
    const loaded = await subject.load("sample-process");
    const before = (
      await executeGit("git", ["rev-parse", "HEAD"], {
        cwd: fixture!.repositoryRoot,
      })
    ).stdout.trim();

    const saved = await subject.save({
      artifactId: "sample-process",
      edges: loaded.blueprint.edges,
      expectedBlobHash: loaded.blobHash,
      nodes: loaded.blueprint.nodes,
      positions: { inspect: { x: 120, y: 80 } },
    });

    const { stdout: localHead } = await executeGit(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: fixture!.repositoryRoot },
    );
    const { stdout: remoteHead } = await executeGit(
      "git",
      ["rev-parse", "origin/main"],
      { cwd: fixture!.repositoryRoot },
    );
    expect(localHead).toBe(remoteHead);
    expect(localHead.trim()).not.toBe(before);
    expect(
      (
        await executeGit(
          "git",
          ["show", "origin/main:blueprints/sample-process.json"],
          { cwd: fixture!.repositoryRoot },
        )
      ).stdout,
    ).toContain('"x": 120');
    expect(saved.positions).toEqual({ inspect: { x: 120, y: 80 } });
    expect(fixture!.attention.list()).toEqual([]);
  });

  it("retains the local commit and raises one durable attention when push fails", async () => {
    const subject = await editor();
    const loaded = await subject.load("sample-process");
    const before = (
      await executeGit("git", ["rev-parse", "HEAD"], {
        cwd: fixture!.repositoryRoot,
      })
    ).stdout.trim();
    await executeGit(
      "git",
      ["remote", "set-url", "origin", join(fixture!.root, "absent-origin.git")],
      { cwd: fixture!.repositoryRoot },
    );

    const error = await subject
      .save({
        artifactId: "sample-process",
        edges: loaded.blueprint.edges,
        expectedBlobHash: loaded.blobHash,
        nodes: loaded.blueprint.nodes,
        positions: { inspect: { x: 240, y: 160 } },
      })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(BlueprintPushError);
    const after = (
      await executeGit("git", ["rev-parse", "HEAD"], {
        cwd: fixture!.repositoryRoot,
      })
    ).stdout.trim();
    expect(after).not.toBe(before);
    expect(
      await readFile(
        join(fixture!.repositoryRoot, "blueprints", "sample-process.json"),
        "utf8",
      ),
    ).toContain('"x": 240');
    expect(fixture!.attention.list()).toEqual([
      expect.objectContaining({
        attentionId: `blueprint-repository:push:${after}`,
        kind: "blueprint-repository",
        message: expect.stringContaining(after),
        scope: "all",
      }),
    ]);
    await executeGit(
      "git",
      ["remote", "set-url", "origin", fixture!.remoteRoot],
      {
        cwd: fixture!.repositoryRoot,
      },
    );
    await fixture!.repository.synchronize();
    expect(fixture!.attention.list()).toEqual([
      expect.objectContaining({
        attentionId: `blueprint-repository:push:${after}`,
        kind: "blueprint-repository",
        message: expect.stringContaining(after),
      }),
    ]);
  });
});
