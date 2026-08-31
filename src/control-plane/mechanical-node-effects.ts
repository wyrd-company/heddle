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
export const mechanicalNodeUses = [
  "finalize",
  "merge",
  "prepare-worktree",
  "review-snapshot",
] as const;
const reviewSnapshotOutputKey = "_outputs.review-snapshot";

export interface MechanicalBoardMirror {
  mirrorTaskStatus(taskId: number, status: string): Promise<void>;
}

export interface MechanicalBoardStatuses {
  completed: string;
  inProgress: string;
  merged: string;
  review: string;
}

export const mechanicalBoardStatusNames = {
  completed: "done",
  inProgress: "in-progress",
  merged: "retrospective",
  review: "review",
} as const satisfies MechanicalBoardStatuses;

export const resolveMechanicalBoardStatuses = (
  configuredStatuses: Iterable<string>,
): MechanicalBoardStatuses => {
  const configured = new Set(configuredStatuses);
  const statuses = {} as MechanicalBoardStatuses;
  for (const [stage, status] of Object.entries(mechanicalBoardStatusNames)) {
    if (!configured.has(status)) {
      throw new Error(
        `Board configuration is missing required mechanical status '${status}'`,
      );
    }
    statuses[stage as keyof MechanicalBoardStatuses] = status;
  }
  return statuses;
};

export type MechanicalBoardStatusSource =
  MechanicalBoardStatuses | (() => Promise<MechanicalBoardStatuses>);

export interface MechanicalNodeEffectOptions {
  board?: MechanicalBoardMirror;
  command?: CommandRunner;
  statuses?: MechanicalBoardStatusSource;
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
  status: (statuses: MechanicalBoardStatuses) => string,
): Promise<void> => {
  if (options.board === undefined || options.statuses === undefined) return;
  if (change.taskId === undefined) return;
  const statuses =
    typeof options.statuses === "function"
      ? await options.statuses()
      : options.statuses;
  await options.board.mirrorTaskStatus(change.taskId, status(statuses));
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
      await mirror(options, change, ({ inProgress }) => inProgress);
      return prepared;
    },
    "review-snapshot": async (input) => {
      const change = await requireChange(input);
      const snapshot = await ensureReviewSnapshot(change, command);
      await mirror(options, change, ({ review }) => review);
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
        await mirror(options, change, ({ merged }) => merged);
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
      await mirror(options, change, ({ completed }) => completed);
      return result;
    },
  };
};
