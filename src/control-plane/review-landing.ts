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
  isReviewObjectId,
  mechanicalWorktreePath,
  readReviewSnapshot,
  resolveMechanicalBranchHead,
  runMechanicalGit,
  type CommandRunner,
  type MechanicalChangeContext,
  type ReviewSnapshot,
} from "./review-snapshot.js";

interface MergeSnapshotResultBase extends Record<string, JsonValue> {
  alreadyMerged: boolean;
  merged: boolean;
  snapshotId: string;
}

interface ReviewIntegrationRemediationCauseBase extends Record<
  string,
  JsonValue
> {
  currentSourceHead: string | null;
  currentTargetHead: string | null;
  reviewedBaseHead: string;
  reviewedSourceHead: string;
  snapshotId: string;
  sourceBranch: string;
  targetBranch: string;
}

export interface ReviewBasisDriftRemediationCause extends ReviewIntegrationRemediationCauseBase {
  kind: "review-basis-drift";
}

export interface ReviewSourceBehindRemediationCause extends ReviewIntegrationRemediationCauseBase {
  currentSourceHead: string;
  currentTargetHead: string;
  kind: "review-source-behind";
}

export type ReviewIntegrationRemediationCause =
  ReviewBasisDriftRemediationCause | ReviewSourceBehindRemediationCause;

export type MergeSnapshotResult =
  | (MergeSnapshotResultBase & {
      dispositions: { merged: true; remediate: false };
    })
  | (MergeSnapshotResultBase & {
      dispositions: { merged: false; remediate: true };
      remediationCause: ReviewIntegrationRemediationCause;
    });

export interface CleanupMergedChangeResult extends Record<string, JsonValue> {
  branchDeleted: boolean;
  snapshotId: string;
  worktreeRemoved: boolean;
}

const isExactAcceptedNoopClosure = (
  change: MechanicalChangeContext,
  snapshot: ReviewSnapshot,
): boolean =>
  snapshot.state === "closed" &&
  snapshot.sourceHead === snapshot.baseHead &&
  snapshot.latestEvent?.verdict === "accepted" &&
  snapshot.latestEvent.sourceHead === snapshot.sourceHead &&
  snapshot.latestEvent.baseHead === snapshot.baseHead &&
  snapshot.closure?.reason === "integrated" &&
  snapshot.closure.destinationBranch === change.baseBranch &&
  snapshot.closure.resultingCommitShas.length === 1 &&
  snapshot.closure.resultingCommitShas[0] === snapshot.sourceHead;

const commandExited = (error: unknown, code: number): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const actual = (error as { code?: number | string }).code;
  return actual === code || actual === String(code);
};

const gitAncestor = async (
  command: CommandRunner,
  repositoryRoot: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> => {
  try {
    await runMechanicalGit(command, repositoryRoot, [
      "merge-base",
      "--is-ancestor",
      ancestor,
      descendant,
    ]);
    return true;
  } catch (error) {
    if (commandExited(error, 1)) return false;
    throw error;
  }
};

const assertRelatedReviewHistory = async (
  command: CommandRunner,
  repositoryRoot: string,
  left: string,
  right: string,
): Promise<void> => {
  try {
    const mergeBase = (
      await runMechanicalGit(command, repositoryRoot, [
        "merge-base",
        left,
        right,
      ])
    ).trim();
    if (!isReviewObjectId(mergeBase)) {
      throw new Error("Reviewed source and target have unrelated histories");
    }
  } catch (error) {
    if (commandExited(error, 1)) {
      throw new Error("Reviewed source and target have unrelated histories");
    }
    throw error;
  }
};

const reviewIntegrationResult = async (
  change: MechanicalChangeContext,
  snapshot: ReviewSnapshot,
  requestedKind: ReviewIntegrationRemediationCause["kind"],
  command: CommandRunner,
): Promise<MergeSnapshotResult> => {
  const [currentSourceHead, currentTargetHead] = await Promise.all([
    resolveMechanicalBranchHead(command, change.repositoryRoot, change.branch),
    resolveMechanicalBranchHead(
      command,
      change.repositoryRoot,
      change.baseBranch,
    ),
  ]);
  const common = {
    reviewedBaseHead: snapshot.baseHead,
    reviewedSourceHead: snapshot.sourceHead,
    snapshotId: snapshot.snapshotId,
    sourceBranch: change.branch,
    targetBranch: change.baseBranch,
  };
  const remediationCause: ReviewIntegrationRemediationCause =
    requestedKind === "review-source-behind" &&
    currentSourceHead === snapshot.sourceHead &&
    currentTargetHead === snapshot.baseHead
      ? {
          ...common,
          currentSourceHead,
          currentTargetHead,
          kind: "review-source-behind",
        }
      : {
          ...common,
          currentSourceHead: currentSourceHead ?? null,
          currentTargetHead: currentTargetHead ?? null,
          kind: "review-basis-drift",
        };
  return {
    alreadyMerged: false,
    dispositions: { merged: false, remediate: true },
    merged: false,
    remediationCause,
    snapshotId: snapshot.snapshotId,
  };
};

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
  if (current.state === "closed") {
    if (
      current.sourceHead !== snapshot.sourceHead ||
      current.baseHead !== snapshot.baseHead ||
      !isExactAcceptedNoopClosure(change, current) ||
      baseHead !== snapshot.baseHead
    ) {
      throw new Error(
        `Snapshot ${snapshot.snapshotId} does not preserve the exact accepted no-op integration`,
      );
    }
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
    return reviewIntegrationResult(
      change,
      snapshot,
      "review-basis-drift",
      command,
    );
  }
  const isExactEvent = (candidate: ReviewSnapshot): boolean =>
    candidate.latestEvent?.sourceHead === snapshot.sourceHead &&
    candidate.latestEvent.baseHead === snapshot.baseHead;
  if (isExactEvent(current) && current.latestEvent?.verdict === "rejected") {
    throw new Error(
      `Snapshot ${snapshot.snapshotId} has a rejected verdict for the exact review basis`,
    );
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

  if (
    !(await gitAncestor(
      command,
      change.repositoryRoot,
      snapshot.baseHead,
      snapshot.sourceHead,
    ))
  ) {
    await assertRelatedReviewHistory(
      command,
      change.repositoryRoot,
      snapshot.baseHead,
      snapshot.sourceHead,
    );
    return reviewIntegrationResult(
      change,
      snapshot,
      "review-source-behind",
      command,
    );
  }
  await assertMechanicalBranchRefs(command, change.repositoryRoot, [
    change.baseBranch,
    change.branch,
  ]);

  const isExactAcceptedEvent = (candidate: ReviewSnapshot): boolean =>
    isExactEvent(candidate) && candidate.latestEvent?.verdict === "accepted";

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
        return reviewIntegrationResult(
          change,
          snapshot,
          "review-basis-drift",
          command,
        );
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

  if (snapshot.sourceHead === snapshot.baseHead) {
    await command(change.repositoryRoot, "gitpr", [
      "close",
      snapshot.snapshotId,
      "--reason",
      "integrated",
      "--destination",
      change.baseBranch,
      "--commit",
      snapshot.sourceHead,
    ]);
    const closed = await readReviewSnapshot(
      change.repositoryRoot,
      snapshot.snapshotId,
      command,
    );
    const [closedSourceHead, closedBaseHead] = await Promise.all([
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
      closed.sourceHead !== snapshot.sourceHead ||
      closed.baseHead !== snapshot.baseHead ||
      !isExactAcceptedNoopClosure(change, closed) ||
      closedSourceHead !== snapshot.sourceHead ||
      closedBaseHead !== snapshot.baseHead
    ) {
      throw new Error(
        "gitpr did not close the exact accepted no-op integration",
      );
    }
    return {
      alreadyMerged: true,
      dispositions: { merged: true, remediate: false },
      merged: false,
      snapshotId: snapshot.snapshotId,
    };
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
      return reviewIntegrationResult(
        change,
        snapshot,
        "review-basis-drift",
        command,
      );
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
  const isMergedApproval =
    snapshot.state === "merged" && snapshot.latestEvent?.verdict === "accepted";
  const isNoopApproval = isExactAcceptedNoopClosure(change, snapshot);
  if (!isMergedApproval && !isNoopApproval) {
    throw new Error(
      `Snapshot ${snapshotId} is not integrated by an exact approval`,
    );
  }
  const baseHead = await resolveMechanicalBranchHead(
    command,
    change.repositoryRoot,
    change.baseBranch,
  );
  if (baseHead === undefined)
    throw new Error("Cleanup base branch does not exist");
  if (isNoopApproval) {
    if (baseHead !== snapshot.baseHead) {
      throw new Error(
        `Snapshot ${snapshotId} does not preserve the exact accepted no-op integration`,
      );
    }
  } else {
    await runMechanicalGit(command, change.repositoryRoot, [
      "merge-base",
      "--is-ancestor",
      snapshot.sourceHead,
      baseHead,
    ]);
  }

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
