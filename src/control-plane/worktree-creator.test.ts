// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { ensureWorktree } from "./worktree-creator.js";

const exec = promisify(execFile);
const scratchDirectories: string[] = [];

const initializeRepository = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true });
  await exec("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: path,
  });
  await exec("git", ["config", "user.email", "test@example.invalid"], {
    cwd: path,
  });
  await exec("git", ["config", "user.name", "Test Operator"], { cwd: path });
  await exec("git", ["commit", "--allow-empty", "--quiet", "-m", "initial"], {
    cwd: path,
  });
};

afterEach(async () => {
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("ensureWorktree", () => {
  it("creates the owned path once and reuses it on retry", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "heddle-worktree-"));
    scratchDirectories.push(scratch);
    const repositoryRoot = join(scratch, "source");
    const worktreesRoot = join(scratch, "worktrees");
    await initializeRepository(repositoryRoot);

    const input = {
      baseRef: "main",
      branch: "task/prepare",
      repositoryName: "sample-repository",
      repositoryRoot,
      worktreeName: "task-prepare",
      worktreesRoot,
    };
    const created = await ensureWorktree(input);
    const reused = await ensureWorktree(input);

    expect(created).toEqual({
      branch: "task/prepare",
      created: true,
      path: join(worktreesRoot, "sample-repository", "task-prepare"),
    });
    expect(reused).toEqual({ ...created, created: false });
  });

  it("rejects an unrelated repository at the owned path", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "heddle-worktree-"));
    scratchDirectories.push(scratch);
    const repositoryRoot = join(scratch, "source");
    const worktreesRoot = join(scratch, "worktrees");
    const ownedPath = join(worktreesRoot, "sample-repository", "task-prepare");
    await initializeRepository(repositoryRoot);
    await initializeRepository(ownedPath);
    await exec("git", ["branch", "-m", "task/prepare"], { cwd: ownedPath });

    await expect(
      ensureWorktree({
        baseRef: "main",
        branch: "task/prepare",
        repositoryName: "sample-repository",
        repositoryRoot,
        worktreeName: "task-prepare",
        worktreesRoot,
      }),
    ).rejects.toThrow(/does not belong/);
  });
});
