// ---
// relationships:
//   implements: heddle
// ---

import { runMechanicalGit, type CommandRunner } from "./review-snapshot.js";

export const assertMechanicalBranchRefs = async (
  command: CommandRunner,
  repositoryRoot: string,
  branches: string[],
): Promise<void> => {
  await Promise.all(
    branches.map((branch) =>
      runMechanicalGit(command, repositoryRoot, [
        "check-ref-format",
        "--branch",
        branch,
      ]),
    ),
  );
};

export const mechanicalWorktreesForBranch = async (
  command: CommandRunner,
  repositoryRoot: string,
  branch: string,
): Promise<string[]> => {
  const output = await runMechanicalGit(command, repositoryRoot, [
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  const branchRef = `refs/heads/${branch}`;
  return output
    .split("\0\0")
    .map((record) => {
      const fields = record.split("\0");
      const path = fields
        .find((field) => field.startsWith("worktree "))
        ?.slice("worktree ".length);
      const actualBranch = fields
        .find((field) => field.startsWith("branch "))
        ?.slice("branch ".length);
      return actualBranch === branchRef ? path : undefined;
    })
    .filter((path): path is string => path !== undefined);
};

export const mechanicalWorktreesForSingleCheckout = async (
  command: CommandRunner,
  repositoryRoot: string,
  branch: string,
): Promise<string[]> => {
  const worktrees = await mechanicalWorktreesForBranch(
    command,
    repositoryRoot,
    branch,
  );
  if (worktrees.length > 1) {
    throw new Error("Merge base branch is checked out in multiple worktrees");
  }
  return worktrees;
};

export const synchronizeMechanicalBaseWorktree = async (
  command: CommandRunner,
  path: string,
  previousHead: string,
  mergedHead: string,
): Promise<void> => {
  const status = await runMechanicalGit(command, path, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status === "") return;
  const [changesFromPreviousHead, untracked] = await Promise.all([
    runMechanicalGit(command, path, [
      "diff",
      "--name-only",
      previousHead,
      "--",
    ]),
    runMechanicalGit(command, path, [
      "ls-files",
      "--others",
      "--exclude-standard",
    ]),
  ]);
  if (changesFromPreviousHead !== "" || untracked !== "") {
    throw new Error(`Merge base worktree ${JSON.stringify(path)} is dirty`);
  }
  await runMechanicalGit(command, path, ["reset", "--hard", mergedHead]);
};

export const synchronizeMechanicalBaseWorktreesAfterRefDrift = async (
  command: CommandRunner,
  paths: string[],
  previousHead: string,
  currentHead: string,
): Promise<void> => {
  if (previousHead === currentHead) return;
  await Promise.all(
    paths.map((path) =>
      synchronizeMechanicalBaseWorktree(
        command,
        path,
        previousHead,
        currentHead,
      ),
    ),
  );
};

export const runMechanicalRefTransaction = async (
  command: CommandRunner,
  repositoryRoot: string,
  instructions: string[],
): Promise<void> => {
  await runMechanicalGit(
    command,
    repositoryRoot,
    ["update-ref", "--stdin"],
    ["start", ...instructions, "prepare", "commit", ""].join("\n"),
  );
};
