// ---
// relationships:
//   implements: heddle
// ---

import { lstat } from "node:fs/promises";

import type { JsonValue } from "../persistence/index.js";
import {
  assertMechanicalBranchRefs,
  mechanicalWorktreesForBranch,
  provisionMechanicalApprovalWorktree,
  removeMechanicalApprovalWorktree,
  runMechanicalRefTransaction,
  synchronizeMechanicalBaseWorktree,
  withMechanicalRefLease,
} from "./mechanical-ref-transaction.js";
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
    await removeMechanicalApprovalWorktree(command, change);
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
  if (
    sourceHead !== snapshot.sourceHead ||
    (baseHead !== snapshot.baseHead && baseHead !== snapshot.sourceHead)
  ) {
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

  await runMechanicalGit(command, change.repositoryRoot, [
    "merge-base",
    "--is-ancestor",
    snapshot.baseHead,
    snapshot.sourceHead,
  ]);
  await assertMechanicalBranchRefs(command, change.repositoryRoot, [
    change.baseBranch,
    change.branch,
  ]);
  let baseWorktrees = await mechanicalWorktreesForBranch(
    command,
    change.repositoryRoot,
    change.baseBranch,
  );
  if (baseWorktrees.length > 1) {
    throw new Error("Merge base branch is checked out in multiple worktrees");
  }
  const baseAlreadyIntegrated = baseHead === snapshot.sourceHead;
  if (!baseAlreadyIntegrated) {
    await Promise.all(
      baseWorktrees.map((path) => assertCleanMechanicalWorktree(command, path)),
    );
    try {
      await runMechanicalRefTransaction(command, change.repositoryRoot, [
        `update refs/heads/${change.baseBranch} ${snapshot.sourceHead} ${snapshot.baseHead}`,
        `verify refs/heads/${change.branch} ${snapshot.sourceHead}`,
      ]);
    } catch (error) {
      const [currentSourceHead, currentBaseHead] = await Promise.all([
        resolveMechanicalBranchHead(
          command,
          change.repositoryRoot,
          change.branch,
        ),
        resolveMechanicalBranchHead(
          command,
          change.repositoryRoot,
          change.baseBranch,
        ),
      ]);
      if (
        currentSourceHead !== snapshot.sourceHead ||
        (currentBaseHead !== snapshot.baseHead &&
          currentBaseHead !== snapshot.sourceHead)
      ) {
        return {
          alreadyMerged: false,
          dispositions: { merged: false, remediate: true },
          merged: false,
          snapshotId,
        };
      }
      if (currentBaseHead !== snapshot.sourceHead) throw error;
    }
  }
  const approvalWorktree = await provisionMechanicalApprovalWorktree(
    command,
    change,
    baseWorktrees,
    snapshot.sourceHead,
  );
  baseWorktrees = approvalWorktree.baseWorktrees;
  await Promise.all(
    baseWorktrees.map((path) =>
      synchronizeMechanicalBaseWorktree(
        command,
        path,
        snapshot.baseHead,
        snapshot.sourceHead,
      ),
    ),
  );
  try {
    let approvalError: unknown;
    try {
      await withMechanicalRefLease(
        change.repositoryRoot,
        `refs/heads/${change.baseBranch}`,
        snapshot.sourceHead,
        () => command(change.repositoryRoot, "gitpr", ["merge", snapshotId]),
      );
    } catch (error) {
      approvalError = error;
    }
    let cleanupError: unknown;
    if (approvalWorktree.ownsApprovalWorktree) {
      try {
        await removeMechanicalApprovalWorktree(command, change);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (approvalError !== undefined && cleanupError !== undefined) {
      throw new AggregateError(
        [approvalError, cleanupError],
        "Snapshot approval failed and its base worktree could not be removed",
      );
    }
    if (approvalError !== undefined) throw approvalError;
    if (cleanupError !== undefined) throw cleanupError;
  } catch (error) {
    const currentBaseHead = await resolveMechanicalBranchHead(
      command,
      change.repositoryRoot,
      change.baseBranch,
    );
    if (currentBaseHead !== snapshot.sourceHead) {
      return {
        alreadyMerged: false,
        dispositions: { merged: false, remediate: true },
        merged: false,
        snapshotId,
      };
    }
    throw error;
  }
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

  const branchHead = await resolveMechanicalBranchHead(
    command,
    change.repositoryRoot,
    change.branch,
  );
  const path = mechanicalWorktreePath(change);
  const worktreeInput = {
    baseRef: change.baseBranch,
    branch: change.branch,
    repositoryName: change.repositoryName,
    repositoryRoot: change.repositoryRoot,
    worktreeName: change.worktreeName,
    worktreesRoot: change.worktreesRoot,
  };
  if (branchHead !== undefined && branchHead !== snapshot.sourceHead) {
    if (!(await pathExists(path))) {
      await ensureWorktree(worktreeInput, (cwd, arguments_) =>
        runMechanicalGit(command, cwd, arguments_),
      );
    }
    throw new Error("Merged branch moved after review");
  }

  await assertMechanicalBranchRefs(command, change.repositoryRoot, [
    change.baseBranch,
    change.branch,
  ]);
  let worktreeRemoved = false;
  if (await pathExists(path)) {
    await ensureWorktree(worktreeInput, (cwd, arguments_) =>
      runMechanicalGit(command, cwd, arguments_),
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

  let branchDeleted = false;
  if (branchHead !== undefined) {
    try {
      await runMechanicalRefTransaction(command, change.repositoryRoot, [
        `verify refs/heads/${change.baseBranch} ${baseHead}`,
        `delete refs/heads/${change.branch} ${branchHead}`,
      ]);
    } catch (error) {
      const currentBranchHead = await resolveMechanicalBranchHead(
        command,
        change.repositoryRoot,
        change.branch,
      );
      if (worktreeRemoved && currentBranchHead !== undefined) {
        try {
          // The removed worktree was clean, so the surviving branch is its complete recovery source.
          await ensureWorktree(worktreeInput, (cwd, arguments_) =>
            runMechanicalGit(command, cwd, arguments_),
          );
        } catch (restorationError) {
          throw new AggregateError(
            [error, restorationError],
            "Cleanup failed and the worktree could not be restored",
          );
        }
      }
      throw error;
    }
    branchDeleted = true;
  }
  return { branchDeleted, snapshotId, worktreeRemoved };
};
