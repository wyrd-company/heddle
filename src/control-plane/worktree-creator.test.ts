// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { lstat, mkdtemp, mkdir, rm } from "node:fs/promises";
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
  it.each(["--detach", "HEAD"])(
    "rejects unsafe branch %s before calling Git",
    async (branch) => {
      let gitCalls = 0;

      await expect(
        ensureWorktree(
          {
            baseRef: "main",
            branch,
            repositoryName: "sample-repository",
            repositoryRoot: "/workspaces/sample-repository",
            worktreeName: "task-prepare",
          },
          async () => {
            gitCalls += 1;
            throw new Error("Git must not be called");
          },
        ),
      ).rejects.toThrow(/branch/);

      expect(gitCalls).toBe(0);
    },
  );

  it.each(["--detach", "HEAD"])(
    "contains unsafe existing branch %s and permits a clean retry",
    async (branch) => {
      const scratch = await mkdtemp(join(tmpdir(), "heddle-worktree-"));
      scratchDirectories.push(scratch);
      const repositoryRoot = join(scratch, "source");
      const worktreesRoot = join(scratch, "worktrees");
      const ownedPath = join(
        worktreesRoot,
        "task-prepare",
        "sample-repository",
      );
      await initializeRepository(repositoryRoot);
      await exec("git", ["update-ref", `refs/heads/${branch}`, "HEAD"], {
        cwd: repositoryRoot,
      });
      const refsBefore = (
        await exec(
          "git",
          ["for-each-ref", "--format=%(refname)", "refs/heads"],
          { cwd: repositoryRoot },
        )
      ).stdout;

      await expect(
        ensureWorktree({
          baseRef: "main",
          branch,
          repositoryName: "sample-repository",
          repositoryRoot,
          worktreeName: "task-prepare",
          worktreesRoot,
        }),
      ).rejects.toThrow(/branch/);

      await expect(lstat(ownedPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (
          await exec(
            "git",
            ["for-each-ref", "--format=%(refname)", "refs/heads"],
            { cwd: repositoryRoot },
          )
        ).stdout,
      ).toBe(refsBefore);

      const prepared = await ensureWorktree({
        baseRef: "main",
        branch: "task/prepare",
        repositoryName: "sample-repository",
        repositoryRoot,
        worktreeName: "task-prepare",
        worktreesRoot,
      });

      expect(prepared).toEqual({
        branch: "task/prepare",
        created: true,
        path: ownedPath,
      });
    },
  );

  it("creates the task-first owner/repository path and reuses it on retry", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "heddle-worktree-"));
    scratchDirectories.push(scratch);
    const repositoryRoot = join(scratch, "source");
    const worktreesRoot = join(scratch, "worktrees");
    await initializeRepository(repositoryRoot);
    await exec("git", ["branch", "integration-base"], { cwd: repositoryRoot });
    await exec(
      "git",
      ["commit", "--allow-empty", "--quiet", "-m", "later change"],
      { cwd: repositoryRoot },
    );

    const input = {
      baseRef: "integration-base",
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
      path: join(worktreesRoot, "task-prepare", "sample-repository"),
    });
    expect(reused).toEqual({ ...created, created: false });
    expect(
      (await exec("git", ["rev-parse", "HEAD"], { cwd: created.path })).stdout,
    ).toBe(
      (
        await exec("git", ["rev-parse", "integration-base"], {
          cwd: repositoryRoot,
        })
      ).stdout,
    );
  });

  it("rejects an option-shaped base ref without creating a worktree or branch", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "heddle-worktree-"));
    scratchDirectories.push(scratch);
    const repositoryRoot = join(scratch, "source");
    const worktreesRoot = join(scratch, "worktrees");
    const ownedPath = join(worktreesRoot, "task-prepare", "sample-repository");
    await initializeRepository(repositoryRoot);

    await expect(
      ensureWorktree({
        baseRef: "--no-checkout",
        branch: "task/prepare",
        repositoryName: "sample-repository",
        repositoryRoot,
        worktreeName: "task-prepare",
        worktreesRoot,
      }),
    ).rejects.toThrow();
    await expect(lstat(ownedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      exec(
        "git",
        ["show-ref", "--verify", "--quiet", "refs/heads/task/prepare"],
        { cwd: repositoryRoot },
      ),
    ).rejects.toThrow();
  });

  it("treats a valid option-shaped base ref as a revision operand", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "heddle-worktree-"));
    scratchDirectories.push(scratch);
    const repositoryRoot = join(scratch, "source");
    const worktreesRoot = join(scratch, "worktrees");
    await initializeRepository(repositoryRoot);
    await exec("git", ["update-ref", "refs/tags/--no-checkout", "HEAD"], {
      cwd: repositoryRoot,
    });
    const expectedHead = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
    ).stdout;
    await exec(
      "git",
      ["commit", "--allow-empty", "--quiet", "-m", "later change"],
      { cwd: repositoryRoot },
    );

    const created = await ensureWorktree({
      baseRef: "--no-checkout",
      branch: "task/prepare",
      repositoryName: "sample-repository",
      repositoryRoot,
      worktreeName: "task-prepare",
      worktreesRoot,
    });

    expect(
      (await exec("git", ["rev-parse", "HEAD"], { cwd: created.path })).stdout,
    ).toBe(expectedHead);
  });

  it("places the option terminator before worktree operands", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "heddle-worktree-"));
    scratchDirectories.push(scratch);
    const repositoryRoot = join(scratch, "source");
    const worktreesRoot = join(scratch, "worktrees");
    const preparedPath = join(
      worktreesRoot,
      "task-prepare",
      "sample-repository",
    );
    const commit = "a".repeat(40);
    const calls: string[][] = [];

    await ensureWorktree(
      {
        baseRef: "integration-base",
        branch: "task/prepare",
        repositoryName: "sample-repository",
        repositoryRoot,
        worktreeName: "task-prepare",
        worktreesRoot,
      },
      async (_cwd, arguments_) => {
        calls.push(arguments_);
        if (arguments_.includes("integration-base^{commit}")) return commit;
        if (arguments_[0] === "show-ref") throw new Error("missing branch");
        if (arguments_[0] === "worktree") return "";
        if (arguments_.includes("--show-toplevel")) return preparedPath;
        if (arguments_.includes("--git-common-dir"))
          return join(repositoryRoot, ".git");
        if (arguments_[0] === "symbolic-ref") return "task/prepare";
        throw new Error(`Unexpected Git call: ${arguments_.join(" ")}`);
      },
    );

    expect(calls.find(([command]) => command === "worktree")).toEqual([
      "worktree",
      "add",
      "--quiet",
      "-b",
      "task/prepare",
      "--",
      preparedPath,
      commit,
    ]);
  });

  it("rejects an unrelated repository at the owned path", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "heddle-worktree-"));
    scratchDirectories.push(scratch);
    const repositoryRoot = join(scratch, "source");
    const worktreesRoot = join(scratch, "worktrees");
    const ownedPath = join(worktreesRoot, "task-prepare", "sample-repository");
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
    const ownedPath = join(worktreesRoot, "task-prepare", "sample-repository");
    await initializeRepository(repositoryRoot);
    await mkdir(join(worktreesRoot, "task-prepare"), { recursive: true });
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
    const scratch = await mkdtemp(join(tmpdir(), "heddle-worktree-"));
    scratchDirectories.push(scratch);
    await expect(
      ensureWorktree({
        baseRef: "main",
        branch: "task/prepare",
        repositoryName: "../outside",
        repositoryRoot: join(scratch, "source"),
        worktreeName: "task-prepare",
        worktreesRoot: join(scratch, "worktrees"),
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
    const repositoryRoot = join(worktreesRoot, "task-prepare");
    await initializeRepository(repositoryRoot);
    await mkdir(join(repositoryRoot, "sample-repository"));

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
