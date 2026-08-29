// ---
// relationships:
//   implements: heddle
// ---

import { lstat } from "node:fs/promises";

import type { JsonValue } from "../persistence/index.js";
import { ensureWorktree } from "./worktree-creator.js";
import {
  assertCleanMechanicalWorktree,
  assertReviewSnapshotMatches,
  defaultMechanicalCommand,
  mechanicalWorktreePath,
  readReviewSnapshot,
  resolveMechanicalBranchHead,
  runMechanicalGit,
  type CommandRunner,
  type MechanicalChangeContext,
} from "./review-snapshot.js";

export interface MergeSnapshotResult extends Record<string, JsonValue> {
  alreadyMerged: boolean;
  dispositions: { merged: boolean; remediate: boolean };
  merged: boolean;
  snapshotId: string;
}

export interface CleanupMergedChangeResult extends Record<string, JsonValue> {
  branchDeleted: boolean;
  snapshotId: string;
  worktreeRemoved: boolean;
}

export const mergeReviewSnapshot = async (
  change: MechanicalChangeContext,
  snapshotId: string,
  command: CommandRunner = defaultMechanicalCommand,
): Promise<MergeSnapshotResult> => {
  const snapshot = await readReviewSnapshot(
    change.repositoryRoot,
    snapshotId,
    command,
  );
  assertReviewSnapshotMatches(change, snapshot);
  const sourceHead = await resolveMechanicalBranchHead(
    command,
    change.repositoryRoot,
    change.branch,
  );
  const baseHead = await resolveMechanicalBranchHead(
    command,
    change.repositoryRoot,
    change.baseBranch,
  );
  if (baseHead === undefined)
    throw new Error("Merge base branch does not exist");

  if (snapshot.status === "approved") {
    await runMechanicalGit(command, change.repositoryRoot, [
      "merge-base",
      "--is-ancestor",
      snapshot.sourceHead,
      baseHead,
    ]);
    return {
      alreadyMerged: true,
      dispositions: { merged: true, remediate: false },
      merged: false,
      snapshotId,
    };
  }
  if (snapshot.status !== "open") {
    throw new Error(`Snapshot ${snapshotId} is not open`);
  }
  if (sourceHead !== snapshot.sourceHead) {
    return {
      alreadyMerged: false,
      dispositions: { merged: false, remediate: true },
      merged: false,
      snapshotId,
    };
  }
  await assertCleanMechanicalWorktree(command, mechanicalWorktreePath(change));
  const mergeCommits = await runMechanicalGit(command, change.repositoryRoot, [
    "rev-list",
    "--min-parents=2",
    `${snapshot.baseHead}..${snapshot.sourceHead}`,
  ]);
  if (mergeCommits !== "") {
    throw new Error("Reviewed change contains a merge commit");
  }

  await command(change.repositoryRoot, "gitpr", ["merge", snapshotId]);
  const approved = await readReviewSnapshot(
    change.repositoryRoot,
    snapshotId,
    command,
  );
  const mergedHead = await resolveMechanicalBranchHead(
    command,
    change.repositoryRoot,
    change.baseBranch,
  );
  if (approved.status !== "approved" || mergedHead !== snapshot.sourceHead) {
    throw new Error("gitpr did not merge the exact reviewed head");
  }
  return {
    alreadyMerged: false,
    dispositions: { merged: true, remediate: false },
    merged: true,
    snapshotId,
  };
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
};

export const cleanupMergedChange = async (
  change: MechanicalChangeContext,
  snapshotId: string,
  command: CommandRunner = defaultMechanicalCommand,
): Promise<CleanupMergedChangeResult> => {
  const snapshot = await readReviewSnapshot(
    change.repositoryRoot,
    snapshotId,
    command,
  );
  assertReviewSnapshotMatches(change, snapshot);
  if (snapshot.status !== "approved") {
    throw new Error(`Snapshot ${snapshotId} is not approved`);
  }
  const baseHead = await resolveMechanicalBranchHead(
    command,
    change.repositoryRoot,
    change.baseBranch,
  );
  if (baseHead === undefined)
    throw new Error("Cleanup base branch does not exist");
  await runMechanicalGit(command, change.repositoryRoot, [
    "merge-base",
    "--is-ancestor",
    snapshot.sourceHead,
    baseHead,
  ]);

  const path = mechanicalWorktreePath(change);
  let worktreeRemoved = false;
  if (await pathExists(path)) {
    await ensureWorktree(
      {
        baseRef: change.baseBranch,
        branch: change.branch,
        repositoryName: change.repositoryName,
        repositoryRoot: change.repositoryRoot,
        worktreeName: change.worktreeName,
        worktreesRoot: change.worktreesRoot,
      },
      (cwd, arguments_) => runMechanicalGit(command, cwd, arguments_),
    );
    await assertCleanMechanicalWorktree(command, path);
    await runMechanicalGit(command, change.repositoryRoot, [
      "worktree",
      "remove",
      "--",
      path,
    ]);
    worktreeRemoved = true;
  }

  const branchHead = await resolveMechanicalBranchHead(
    command,
    change.repositoryRoot,
    change.branch,
  );
  let branchDeleted = false;
  if (branchHead !== undefined) {
    if (branchHead !== snapshot.sourceHead) {
      throw new Error("Merged branch moved after review");
    }
    await runMechanicalGit(command, change.repositoryRoot, [
      "update-ref",
      "-d",
      `refs/heads/${change.branch}`,
      branchHead,
    ]);
    branchDeleted = true;
  }
  return { branchDeleted, snapshotId, worktreeRemoved };
};
