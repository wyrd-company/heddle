// ---
// relationships:
//   implements: heddle
// ---

import { execFile } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type WorktreeInput = {
  baseRef: string;
  branch: string;
  repositoryName: string;
  repositoryRoot: string;
  worktreeName: string;
  worktreesRoot?: string;
};

export type PreparedWorktree = {
  branch: string;
  created: boolean;
  path: string;
};

export type GitRunner = (cwd: string, arguments_: string[]) => Promise<string>;

const runGit: GitRunner = (cwd, arguments_) =>
  new Promise((resolvePromise, reject) => {
    execFile("git", arguments_, { cwd, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolvePromise(stdout);
    });
  });

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
};

const assertPathSegment = (label: string, value: string): void => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new TypeError(`${label} must be one safe path segment`);
  }
};

const assertCommitRef = async (
  repositoryRoot: string,
  baseRef: string,
  git: GitRunner,
): Promise<void> => {
  try {
    await git(repositoryRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${baseRef}^{commit}`,
    ]);
  } catch {
    throw new TypeError(`baseRef '${baseRef}' must resolve to a commit`);
  }
};

const verifyWorktree = async (
  path: string,
  branch: string,
  repositoryRoot: string,
  git: GitRunner,
): Promise<void> => {
  const actualRoot = (
    await git(path, ["rev-parse", "--path-format=absolute", "--show-toplevel"])
  ).trim();
  if (resolve(actualRoot) !== resolve(path)) {
    throw new Error(
      `Existing worktree root '${actualRoot}' does not match '${path}'`,
    );
  }
  const actualBranch = (
    await git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  ).trim();
  if (actualBranch !== branch) {
    throw new Error(
      `Existing worktree '${path}' uses branch '${actualBranch}', expected '${branch}'`,
    );
  }
  const expectedCommonDirectory = (
    await git(repositoryRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])
  ).trim();
  const actualCommonDirectory = (
    await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  ).trim();
  if (resolve(actualCommonDirectory) !== resolve(expectedCommonDirectory)) {
    throw new Error(
      `Existing worktree '${path}' does not belong to repository '${repositoryRoot}'`,
    );
  }
};

export const ensureWorktree = async (
  input: WorktreeInput,
  git: GitRunner = runGit,
): Promise<PreparedWorktree> => {
  assertPathSegment("repositoryName", input.repositoryName);
  assertPathSegment("worktreeName", input.worktreeName);
  if (input.branch.trim() === "")
    throw new TypeError("branch must not be empty");
  if (input.baseRef.trim() === "")
    throw new TypeError("baseRef must not be empty");

  await assertCommitRef(input.repositoryRoot, input.baseRef, git);

  const path = join(
    input.worktreesRoot ?? "/workspaces/worktrees",
    input.repositoryName,
    input.worktreeName,
  );
  if (await exists(path)) {
    await verifyWorktree(path, input.branch, input.repositoryRoot, git);
    return { branch: input.branch, created: false, path };
  }

  await mkdir(dirname(path), { recursive: true });
  let branchExists = true;
  try {
    await git(input.repositoryRoot, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${input.branch}`,
    ]);
  } catch {
    branchExists = false;
  }

  const arguments_ = branchExists
    ? ["worktree", "add", "--quiet", "--", path, input.branch]
    : [
        "worktree",
        "add",
        "--quiet",
        "-b",
        input.branch,
        "--",
        path,
        input.baseRef,
      ];
  let created = true;
  try {
    await git(input.repositoryRoot, arguments_);
  } catch (error) {
    if (!(await exists(path))) throw error;
    created = false;
  }
  await verifyWorktree(path, input.branch, input.repositoryRoot, git);
  return { branch: input.branch, created, path };
};
