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

  it("rejects an existing worktree on the wrong branch", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "heddle-worktree-"));
    scratchDirectories.push(scratch);
    const repositoryRoot = join(scratch, "source");
    const worktreesRoot = join(scratch, "worktrees");
    const ownedPath = join(worktreesRoot, "sample-repository", "task-prepare");
    await initializeRepository(repositoryRoot);
    await mkdir(join(worktreesRoot, "sample-repository"), { recursive: true });
    await exec(
      "git",
      ["worktree", "add", "--quiet", "-b", "task/other", ownedPath, "main"],
      { cwd: repositoryRoot },
    );

    await expect(
      ensureWorktree({
        baseRef: "main",
        branch: "task/prepare",
        repositoryName: "sample-repository",
        repositoryRoot,
        worktreeName: "task-prepare",
        worktreesRoot,
      }),
    ).rejects.toThrow(/uses branch/);
  });

  it("rejects path traversal names", async () => {
    await expect(
      ensureWorktree({
        baseRef: "main",
        branch: "task/prepare",
        repositoryName: "../outside",
        repositoryRoot: "/workspaces/sample-repository",
        worktreeName: "task-prepare",
      }),
    ).rejects.toThrow(/safe path segment/);
  });

  it("rejects empty branch and base references", async () => {
    const common = {
      repositoryName: "sample-repository",
      repositoryRoot: "/workspaces/sample-repository",
      worktreeName: "task-prepare",
    };

    await expect(
      ensureWorktree({ ...common, baseRef: "main", branch: " " }),
    ).rejects.toThrow(/branch/);
    await expect(
      ensureWorktree({ ...common, baseRef: " ", branch: "task/prepare" }),
    ).rejects.toThrow(/baseRef/);
  });

  it("rejects a nested directory that is not a worktree root", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "heddle-worktree-"));
    scratchDirectories.push(scratch);
    const worktreesRoot = join(scratch, "worktrees");
    const repositoryRoot = join(worktreesRoot, "sample-repository");
    await initializeRepository(repositoryRoot);
    await mkdir(join(repositoryRoot, "task-prepare"));

    await expect(
      ensureWorktree({
        baseRef: "main",
        branch: "main",
        repositoryName: "sample-repository",
        repositoryRoot,
        worktreeName: "task-prepare",
        worktreesRoot,
      }),
    ).rejects.toThrow(/root/);
  });
});
