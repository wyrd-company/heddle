// ---
// relationships:
//   implements: heddle
// ---

import type { LifecycleEffect, LifecycleEffectInput } from "../engine/index.js";
import { ensureWorktree, type GitRunner } from "./worktree-creator.js";
import {
  cleanupMergedChange,
  mergeReviewSnapshot,
  type CleanupMergedChangeResult,
  type MergeSnapshotResult,
} from "./review-landing.js";
import {
  defaultMechanicalCommand,
  ensureReviewSnapshot,
  runMechanicalGit,
  type CommandRunner,
  type MechanicalChangeContext,
  type ReviewSnapshot,
} from "./review-snapshot.js";

export {
  cleanupMergedChange,
  ensureReviewSnapshot,
  mergeReviewSnapshot,
  type CleanupMergedChangeResult,
  type CommandRunner,
  type MechanicalChangeContext,
  type MergeSnapshotResult,
  type ReviewSnapshot,
};

export const mechanicalChangeContextKey = "_heddleMechanicalChange";
const reviewSnapshotOutputKey = "_outputs.review-snapshot";

export interface MechanicalBoardMirror {
  mirrorChildStatus(taskId: number, status: string): Promise<void>;
}

export interface MechanicalNodeEffectOptions {
  board?: MechanicalBoardMirror;
  command?: CommandRunner;
  statuses?: {
    completed: string;
    inProgress: string;
    merged: string;
    review: string;
  };
}

const requireChange = async (
  input: LifecycleEffectInput,
): Promise<MechanicalChangeContext> => {
  const value = await input.context.get(mechanicalChangeContextKey);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Mechanical change context is missing");
  }
  const change = value as Partial<MechanicalChangeContext>;
  for (const key of [
    "baseBranch",
    "branch",
    "repositoryName",
    "repositoryRoot",
    "reviewDescription",
    "reviewTitle",
    "worktreeName",
  ] as const) {
    if (typeof change[key] !== "string") {
      throw new Error(`Mechanical change context is missing ${key}`);
    }
  }
  return change as MechanicalChangeContext;
};

const requireSnapshotOutput = async (
  input: LifecycleEffectInput,
): Promise<ReviewSnapshot> => {
  const value = await input.context.get(reviewSnapshotOutputKey);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Partial<ReviewSnapshot>).snapshotId !== "string"
  ) {
    throw new Error("Review snapshot output is missing");
  }
  return value as ReviewSnapshot;
};

const mirror = async (
  options: MechanicalNodeEffectOptions,
  change: MechanicalChangeContext,
  status: string | undefined,
): Promise<void> => {
  if (options.board === undefined || status === undefined) return;
  if (change.taskId === undefined) {
    throw new Error("Mechanical change context is missing taskId");
  }
  await options.board.mirrorChildStatus(change.taskId, status);
};

export const createMechanicalNodeEffects = (
  options: MechanicalNodeEffectOptions = {},
): Record<
  "finalize" | "merge" | "prepare-worktree" | "review-snapshot",
  LifecycleEffect
> => {
  const command = options.command ?? defaultMechanicalCommand;
  const git: GitRunner = (cwd, arguments_) =>
    runMechanicalGit(command, cwd, arguments_);
  return {
    "prepare-worktree": async (input) => {
      const change = await requireChange(input);
      const prepared = await ensureWorktree(
        {
          baseRef: change.baseBranch,
          branch: change.branch,
          repositoryName: change.repositoryName,
          repositoryRoot: change.repositoryRoot,
          worktreeName: change.worktreeName,
          worktreesRoot: change.worktreesRoot,
        },
        git,
      );
      await mirror(options, change, options.statuses?.inProgress);
      return prepared;
    },
    "review-snapshot": async (input) => {
      const change = await requireChange(input);
      const snapshot = await ensureReviewSnapshot(change, command);
      await mirror(options, change, options.statuses?.review);
      return snapshot;
    },
    merge: async (input) => {
      const change = await requireChange(input);
      const snapshot = await requireSnapshotOutput(input);
      const result = await mergeReviewSnapshot(
        change,
        snapshot.snapshotId,
        command,
      );
      if (result.merged || result.alreadyMerged) {
        await mirror(options, change, options.statuses?.merged);
      }
      return result;
    },
    finalize: async (input) => {
      const change = await requireChange(input);
      const snapshot = await requireSnapshotOutput(input);
      const result = await cleanupMergedChange(
        change,
        snapshot.snapshotId,
        command,
      );
      await mirror(options, change, options.statuses?.completed);
      return result;
    },
  };
};
