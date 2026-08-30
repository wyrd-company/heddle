// ---
// relationships:
//   verifies: heddle
// ---

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BlueprintPushError } from "./blueprint-repository.js";
import {
  prepareBlueprintRepositoryFixture,
  type BlueprintRepositoryFixture,
  executeGit,
} from "./blueprint-repository.test-support.js";
import { OrganizationBlueprintArtifactEditor } from "./product-blueprint-editor.js";

describe("organization blueprint artifact editor", () => {
  let fixture: BlueprintRepositoryFixture | undefined;

  afterEach(async () => {
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
