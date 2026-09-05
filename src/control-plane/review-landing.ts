// ---
// relationships:
//   implements: heddle
// ---

import { lstat } from "node:fs/promises";

import type { JsonValue } from "../persistence/index.js";
import {
  assertMechanicalBranchRefs,
  mechanicalWorktreesForSingleCheckout,
  runMechanicalRefTransaction,
  synchronizeMechanicalBaseWorktreesAfterRefDrift,
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
  type ReviewSnapshot,
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
  snapshot: ReviewSnapshot,
  command: CommandRunner = defaultMechanicalCommand,
): Promise<MergeSnapshotResult> => {
  const current = await readReviewSnapshot(
    change.repositoryRoot,
    snapshot.snapshotId,
    command,
  );
  assertReviewSnapshotMatches(change, snapshot);
  assertReviewSnapshotMatches(change, current);
  const baseHead = await resolveMechanicalBranchHead(
    command,
    change.repositoryRoot,
    change.baseBranch,
  );
  if (baseHead === undefined)
    throw new Error("Merge base branch does not exist");
  if (current.state === "merged") {
    if (
      current.latestEvent?.verdict !== "accepted" ||
      current.sourceHead !== snapshot.sourceHead ||
      current.baseHead !== snapshot.baseHead
    ) {
      throw new Error("Merged gitpr review event does not match the snapshot");
    }
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
      snapshotId: snapshot.snapshotId,
    };
  }
  if (current.state !== "open") {
    throw new Error(`Snapshot ${snapshot.snapshotId} is not open`);
  }
  const baseWorktrees = await mechanicalWorktreesForSingleCheckout(
    command,
    change.repositoryRoot,
    change.baseBranch,
  );
  if (
    current.sourceHead !== snapshot.sourceHead ||
    current.baseHead !== snapshot.baseHead
  ) {
    await synchronizeMechanicalBaseWorktreesAfterRefDrift(
      command,
      baseWorktrees,
      snapshot.baseHead,
      current.baseHead,
    );
    return {
      alreadyMerged: false,
      dispositions: { merged: false, remediate: true },
      merged: false,
      snapshotId: snapshot.snapshotId,
    };
  }
  await assertCleanMechanicalWorktree(command, mechanicalWorktreePath(change));
  await Promise.all(
    baseWorktrees.map((path) => assertCleanMechanicalWorktree(command, path)),
  );
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

  const isExactAcceptedEvent = (candidate: ReviewSnapshot): boolean =>
    candidate.latestEvent?.verdict === "accepted" &&
    candidate.latestEvent.sourceHead === snapshot.sourceHead &&
    candidate.latestEvent.baseHead === snapshot.baseHead;

  if (!isExactAcceptedEvent(current)) {
    try {
      // The merge node is reachable only from the review wait stage's approve
      // disposition. Record that reviewer judgment against the persisted basis
      // before asking gitpr to land it.
      await command(change.repositoryRoot, "gitpr", [
        "approve",
        snapshot.snapshotId,
        "--basis",
        `${snapshot.sourceHead}:${snapshot.baseHead}`,
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
        currentBaseHead !== snapshot.baseHead
      ) {
        return {
          alreadyMerged: false,
          dispositions: { merged: false, remediate: true },
          merged: false,
          snapshotId: snapshot.snapshotId,
        };
      }
      throw error;
    }
    const approved = await readReviewSnapshot(
      change.repositoryRoot,
      snapshot.snapshotId,
      command,
    );
    if (approved.state !== "open" || !isExactAcceptedEvent(approved)) {
      throw new Error("gitpr did not record the exact review approval");
    }
  }

  try {
    await command(change.repositoryRoot, "gitpr", [
      "merge",
      snapshot.snapshotId,
    ]);
  } catch (error) {
    const afterFailure = await readReviewSnapshot(
      change.repositoryRoot,
      snapshot.snapshotId,
      command,
    );
    if (
      afterFailure.state === "open" &&
      (afterFailure.sourceHead !== snapshot.sourceHead ||
        afterFailure.baseHead !== snapshot.baseHead)
    ) {
      return {
        alreadyMerged: false,
        dispositions: { merged: false, remediate: true },
        merged: false,
        snapshotId: snapshot.snapshotId,
      };
    }
    throw error;
  }
  const approved = await readReviewSnapshot(
    change.repositoryRoot,
    snapshot.snapshotId,
    command,
  );
  const mergedHead = await resolveMechanicalBranchHead(
    command,
    change.repositoryRoot,
    change.baseBranch,
  );
  if (
    approved.state !== "merged" ||
    !isExactAcceptedEvent(approved) ||
    mergedHead !== snapshot.sourceHead
  ) {
    throw new Error("gitpr did not merge the exact reviewed head");
  }
  return {
    alreadyMerged: false,
    dispositions: { merged: true, remediate: false },
    merged: true,
    snapshotId: snapshot.snapshotId,
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
  if (
    snapshot.state !== "merged" ||
    snapshot.latestEvent?.verdict !== "accepted"
  ) {
    throw new Error(`Snapshot ${snapshotId} is not merged by an approval`);
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
