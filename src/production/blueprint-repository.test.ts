// ---
// relationships:
//   verifies: heddle
// ---

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  validateConsoleAttentionCatalog,
  MAXIMUM_CONSOLE_ATTENTION_IDENTIFIER_LENGTH,
} from "../console/index.js";
import { InvalidDispositionError, LifecycleEngine } from "../engine/index.js";
import {
  executeGit,
  prepareBlueprintRepositoryFixture,
  type BlueprintRepositoryFixture,
} from "./blueprint-repository.test-support.js";

describe("organization blueprint repository", () => {
  let fixture: BlueprintRepositoryFixture | undefined;

  afterEach(async () => {
    await fixture?.cleanup();
    fixture = undefined;
  });

  const prepare = async () => {
    fixture = await prepareBlueprintRepositoryFixture();
    return fixture;
  };

  const publisher = async (setup: BlueprintRepositoryFixture) => {
    const path = join(setup.root, "publisher");
    await executeGit(
      "git",
      ["clone", "--quiet", "--branch", "main", setup.remoteRoot, path],
      { cwd: setup.root },
    );
    await executeGit("git", ["config", "user.name", "Fixture User"], {
      cwd: path,
    });
    await executeGit(
      "git",
      ["config", "user.email", "fixture@example.invalid"],
      { cwd: path },
    );
    return path;
  };

  it("fetches only remote refs while old instances keep their pinned blob and new instances use upstream", async () => {
    const setup = await prepare();
    const effects = {
      finish: async () => ({ finished: true }),
      prepare: async () => ({ prepared: true }),
    };
    const lifecycle = new LifecycleEngine({
      effects,
      persistence: setup.persistence,
      repositoryRoot: setup.repositoryRoot,
      sourceRef: setup.repository.sourceRef,
    });
    const old = await lifecycle.start({
      blueprintPath: "blueprints/sample-process.json",
      instanceId: "instance-old",
    });
    const rebaseCandidate = await lifecycle.start({
      blueprintPath: "blueprints/sample-process.json",
      instanceId: "instance-rebase",
    });
    expect(old.awaitingNodeIds).toEqual(["inspect"]);
    expect(rebaseCandidate.blueprintBlobHash).toBe(old.blueprintBlobHash);
    expect(
      (
        await executeGit(
          "git",
          [
            "rev-parse",
            "--verify",
            `refs/heddle/blueprints/${old.blueprintBlobHash}`,
          ],
          { cwd: setup.repositoryRoot },
        )
      ).stdout.trim(),
    ).toBe(old.blueprintBlobHash);
    await executeGit(
      "git",
      [
        "config",
        "--add",
        "remote.origin.fetch",
        "+refs/heads/*:refs/heddle/untrusted-fetch/*",
      ],
      { cwd: setup.repositoryRoot },
    );
    const workingBytes = await readFile(
      join(setup.repositoryRoot, "blueprints", "sample-process.json"),
      "utf8",
    );

    const upstream = await publisher(setup);
    const upstreamPath = join(upstream, "blueprints", "sample-process.json");
    const artifact = JSON.parse(await readFile(upstreamPath, "utf8")) as {
      edges: Array<Record<string, unknown>>;
    };
    const waitEdge = artifact.edges.find(({ source }) => source === "inspect")!;
    waitEdge.condition = "result.output.dispositions.proceed";
    waitEdge.disposition = "proceed";
    await writeFile(upstreamPath, `${JSON.stringify(artifact, null, 2)}\n`);
    await executeGit("git", ["add", "blueprints/sample-process.json"], {
      cwd: upstream,
    });
    await executeGit(
      "git",
      ["commit", "--quiet", "-m", "Revise sample route"],
      {
        cwd: upstream,
      },
    );
    await executeGit("git", ["push", "--quiet"], { cwd: upstream });

    const localHeadBefore = (
      await executeGit("git", ["rev-parse", "HEAD"], {
        cwd: setup.repositoryRoot,
      })
    ).stdout.trim();
    await setup.repository.synchronize();
    const localHeadAfter = (
      await executeGit("git", ["rev-parse", "HEAD"], {
        cwd: setup.repositoryRoot,
      })
    ).stdout.trim();
    expect(localHeadAfter).toBe(localHeadBefore);
    expect(
      (
        await executeGit(
          "git",
          [
            "rev-parse",
            "--verify",
            `refs/heddle/blueprints/${old.blueprintBlobHash}`,
          ],
          { cwd: setup.repositoryRoot },
        )
      ).stdout.trim(),
    ).toBe(old.blueprintBlobHash);
    await expect(
      executeGit(
        "git",
        ["show-ref", "--verify", "--quiet", "refs/heddle/untrusted-fetch/main"],
        { cwd: setup.repositoryRoot },
      ),
    ).rejects.toMatchObject({ code: 1 });
    expect(
      await readFile(
        join(setup.repositoryRoot, "blueprints", "sample-process.json"),
        "utf8",
      ),
    ).toBe(workingBytes);

    const fresh = await lifecycle.start({
      blueprintPath: "blueprints/sample-process.json",
      instanceId: "instance-new",
    });
    expect(fresh.awaitingNodeIds).toEqual(["inspect"]);
    const rebased = await lifecycle.rebase({
      instanceId: "instance-rebase",
      targetState: "inspect",
    });
    expect(rebased.blueprintBlobHash).toBe(fresh.blueprintBlobHash);
    expect(rebased.blueprintBlobHash).not.toBe(old.blueprintBlobHash);
    await expect(
      lifecycle.resume({
        disposition: "complete",
        instanceId: "instance-old",
        operationId: "old-completion",
      }),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      lifecycle.resume({
        disposition: "complete",
        instanceId: "instance-new",
        operationId: "wrong-new-completion",
      }),
    ).rejects.toBeInstanceOf(InvalidDispositionError);
    await expect(
      lifecycle.resume({
        disposition: "proceed",
        instanceId: "instance-new",
        operationId: "new-completion",
      }),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      lifecycle.resume({
        disposition: "proceed",
        instanceId: "instance-rebase",
        operationId: "rebased-completion",
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(setup.attention.list()).toEqual([
      expect.objectContaining({
        kind: "blueprint-repository",
        message: expect.stringContaining(
          "The organization blueprint repository branch is behind origin",
        ),
      }),
    ]);
  });

  it("raises one dirty-tree attention without changing the branch or working bytes", async () => {
    const setup = await prepare();
    const path = join(setup.repositoryRoot, "notes.txt");
    await writeFile(path, "local note\n");
    const before = (
      await executeGit("git", ["rev-parse", "HEAD"], {
        cwd: setup.repositoryRoot,
      })
    ).stdout.trim();

    await setup.repository.synchronize();

    expect(
      (
        await executeGit("git", ["rev-parse", "HEAD"], {
          cwd: setup.repositoryRoot,
        })
      ).stdout.trim(),
    ).toBe(before);
    expect(await readFile(path, "utf8")).toBe("local note\n");
    const catalog = setup.attention.list();
    expect(catalog).toEqual([
      expect.objectContaining({
        kind: "blueprint-repository",
        message: expect.stringContaining(
          "The organization blueprint repository working tree has local changes",
        ),
      }),
    ]);
    const head = (
      await executeGit("git", ["rev-parse", "HEAD"], {
        cwd: setup.repositoryRoot,
      })
    ).stdout.trim();
    expect(catalog[0]!.message).toContain(head);
    expect(catalog[0]!.attentionId.length).toBeLessThanOrEqual(
      MAXIMUM_CONSOLE_ATTENTION_IDENTIFIER_LENGTH,
    );
    expect(() => validateConsoleAttentionCatalog(catalog, false)).not.toThrow();
  });

  it("refuses an attention identity the console cannot carry", async () => {
    const setup = await prepare();

    await expect(
      setup.attention.raise({
        attentionId: `blueprint-repository:state:${"a".repeat(MAXIMUM_CONSOLE_ATTENTION_IDENTIFIER_LENGTH)}`,
        category: "state",
        code: "blueprint-repository-dirty",
        kind: "blueprint-repository",
        message: "The organization blueprint repository needs attention",
        repositoryRoot: setup.repositoryRoot,
      }),
    ).rejects.toThrow("exceeds the console attention identity bound");
    expect(setup.attention.list()).toEqual([]);
  });

  it("fails closed with one durable attention when origin cannot be fetched", async () => {
    const setup = await prepare();
    const before = (
      await executeGit("git", ["rev-parse", "HEAD"], {
        cwd: setup.repositoryRoot,
      })
    ).stdout.trim();
    await executeGit(
      "git",
      ["remote", "set-url", "origin", join(setup.root, "missing.git")],
      { cwd: setup.repositoryRoot },
    );

    await expect(setup.repository.synchronize()).rejects.toThrow(
      "could not fetch origin",
    );

    expect(
      (
        await executeGit("git", ["rev-parse", "HEAD"], {
          cwd: setup.repositoryRoot,
        })
      ).stdout.trim(),
    ).toBe(before);
    expect(setup.attention.list()).toEqual([
      expect.objectContaining({
        attentionId: "blueprint-repository:state:fetch-failed",
        kind: "blueprint-repository",
        message: "The organization blueprint repository could not fetch origin",
      }),
    ]);
  });

  it("raises one divergence attention and never merges, rebases, or resets either commit", async () => {
    const setup = await prepare();
    await writeFile(join(setup.repositoryRoot, "local.txt"), "local\n");
    await executeGit("git", ["add", "local.txt"], {
      cwd: setup.repositoryRoot,
    });
    await executeGit("git", ["commit", "--quiet", "-m", "Add local note"], {
      cwd: setup.repositoryRoot,
    });
    const localCommit = (
      await executeGit("git", ["rev-parse", "HEAD"], {
        cwd: setup.repositoryRoot,
      })
    ).stdout.trim();
    const upstream = await publisher(setup);
    await writeFile(join(upstream, "remote.txt"), "remote\n");
    await executeGit("git", ["add", "remote.txt"], { cwd: upstream });
    await executeGit("git", ["commit", "--quiet", "-m", "Add remote note"], {
      cwd: upstream,
    });
    await executeGit("git", ["push", "--quiet"], { cwd: upstream });
    const remoteCommit = (
      await executeGit("git", ["rev-parse", "HEAD"], { cwd: upstream })
    ).stdout.trim();

    await setup.repository.synchronize();

    expect(
      (
        await executeGit("git", ["rev-parse", "HEAD"], {
          cwd: setup.repositoryRoot,
        })
      ).stdout.trim(),
    ).toBe(localCommit);
    expect(
      (
        await executeGit("git", ["rev-parse", "origin/main"], {
          cwd: setup.repositoryRoot,
        })
      ).stdout.trim(),
    ).toBe(remoteCommit);
    expect(setup.attention.list()).toEqual([
      expect.objectContaining({
        kind: "blueprint-repository",
        message: expect.stringContaining(
          "The organization blueprint repository has diverged from origin",
        ),
      }),
    ]);
  });
});
