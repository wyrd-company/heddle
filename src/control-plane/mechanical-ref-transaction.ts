// ---
// relationships:
//   implements: heddle
// ---

import { spawn } from "node:child_process";

import { ensureWorktree } from "./worktree-creator.js";
import {
  assertCleanMechanicalWorktree,
  mechanicalWorktreePath,
  runMechanicalGit,
  type CommandRunner,
  type MechanicalChangeContext,
} from "./review-snapshot.js";

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

const mechanicalApprovalWorktreePath = (
  change: MechanicalChangeContext,
): string =>
  mechanicalWorktreePath({
    ...change,
    worktreeName: `${change.worktreeName}.merge-base`,
  });

export const provisionMechanicalApprovalWorktree = async (
  command: CommandRunner,
  change: MechanicalChangeContext,
  baseWorktrees: string[],
  mergedHead: string,
): Promise<{ baseWorktrees: string[]; ownsApprovalWorktree: boolean }> => {
  const approvalWorktreePath = mechanicalApprovalWorktreePath(change);
  if (baseWorktrees.length > 0) {
    return {
      baseWorktrees,
      ownsApprovalWorktree: baseWorktrees.includes(approvalWorktreePath),
    };
  }
  await ensureWorktree(
    {
      baseRef: mergedHead,
      branch: change.baseBranch,
      repositoryName: change.repositoryName,
      repositoryRoot: change.repositoryRoot,
      worktreeName: `${change.worktreeName}.merge-base`,
      worktreesRoot: change.worktreesRoot,
    },
    (cwd, arguments_) => runMechanicalGit(command, cwd, arguments_),
  );
  return {
    baseWorktrees: [approvalWorktreePath],
    ownsApprovalWorktree: true,
  };
};

export const removeMechanicalApprovalWorktree = async (
  command: CommandRunner,
  change: MechanicalChangeContext,
): Promise<void> => {
  const path = mechanicalApprovalWorktreePath(change);
  const baseWorktrees = await mechanicalWorktreesForBranch(
    command,
    change.repositoryRoot,
    change.baseBranch,
  );
  if (!baseWorktrees.includes(path)) return;
  await assertCleanMechanicalWorktree(command, path);
  await runMechanicalGit(command, change.repositoryRoot, [
    "worktree",
    "remove",
    "--",
    path,
  ]);
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

export const withMechanicalRefLease = async <T>(
  repositoryRoot: string,
  ref: string,
  expectedHead: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const child = spawn("git", ["update-ref", "--stdin"], {
    cwd: repositoryRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    errors += chunk;
  });
  const prepared = new Promise<void>((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes("prepare: ok\n")) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!output.includes("prepare: ok\n")) {
        reject(
          new Error(
            `Could not lease ${ref}: ${errors.trim() || `git exited ${code}`}`,
          ),
        );
      }
    });
  });
  child.stdin.write(`start\nverify ${ref} ${expectedHead}\nprepare\n`);
  await prepared;
  try {
    return await operation();
  } finally {
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Could not release ${ref}: ${errors.trim()}`));
      });
    });
    child.stdin.end("abort\n");
    await exited;
  }
};
