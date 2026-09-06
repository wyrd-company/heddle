// ---
// relationships:
//   implements: heddle
// ---

import {
  boardStatusForMechanicalNode,
  type LifecycleEffect,
  type LifecycleEffectInput,
  type MechanicalNodeUse,
} from "../engine/index.js";

import { ensureWorktree, type GitRunner } from "./worktree-creator.js";
import {
  cleanupMergedChange,
  mergeReviewSnapshot,
  type CleanupMergedChangeResult,
  type MergeSnapshotResult,
  type ReviewBasisDriftRemediationCause,
  type ReviewIntegrationRemediationCause,
  type ReviewSourceBehindRemediationCause,
} from "./review-landing.js";
import {
  defaultMechanicalCommand,
  ensureReviewSnapshot,
  isReviewObjectId,
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
  type ReviewBasisDriftRemediationCause,
  type ReviewIntegrationRemediationCause,
  type ReviewSourceBehindRemediationCause,
  type ReviewSnapshot,
};

export { mechanicalNodeUses } from "../engine/index.js";

export const mechanicalChangeContextKey = "_heddleMechanicalChange";
const reviewSnapshotOutputKey = "_outputs.review-snapshot";

export interface MechanicalBoardMirror {
  mirrorTaskStatus(taskId: number, status: string): Promise<void>;
}

export const assertMechanicalBoardStatusConfigured = (
  uses: MechanicalNodeUse,
  status: string,
  configuredStatuses: Iterable<string>,
): void => {
  if (!new Set(configuredStatuses).has(status)) {
    throw new Error(
      `Blueprint board-statuses maps mechanical node use ${JSON.stringify(uses)} to status ${JSON.stringify(status)}, which is absent from the board configuration`,
    );
  }
};

export const resolveMechanicalBoardStatuses = (
  blueprint: LifecycleEffectInput["blueprint"],
  configuredStatuses: Iterable<string>,
): Readonly<Partial<Record<MechanicalNodeUse, string>>> => {
  const configured = new Set(configuredStatuses);
  const statuses = blueprint["board-statuses"] ?? {};
  for (const [uses, status] of Object.entries(statuses)) {
    assertMechanicalBoardStatusConfigured(
      uses as MechanicalNodeUse,
      status,
      configured,
    );
  }
  return statuses;
};

export type MechanicalBoardStatusSource =
  Iterable<string> | (() => Promise<Iterable<string>>);

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
  const snapshot = value as Partial<ReviewSnapshot>;
  for (const key of ["sourceHead", "baseHead"] as const) {
    if (!isReviewObjectId(snapshot[key])) {
      throw new Error(`Review snapshot output has invalid ${key}`);
    }
  }
  return snapshot as ReviewSnapshot;
};

const mirrorStatuses = async (
  input: LifecycleEffectInput,
  options: MechanicalNodeEffectOptions,
  change: MechanicalChangeContext,
): Promise<
  Readonly<Partial<Record<MechanicalNodeUse, string>>> | undefined
> => {
  if (options.board === undefined || options.statuses === undefined) {
    return undefined;
  }
  if (change.taskId === undefined) return;
  const configured =
    typeof options.statuses === "function"
      ? await options.statuses()
      : options.statuses;
  return resolveMechanicalBoardStatuses(input.blueprint, configured);
};

const mirror = async (
  input: LifecycleEffectInput,
  options: MechanicalNodeEffectOptions,
  change: MechanicalChangeContext,
  statuses: Readonly<Partial<Record<MechanicalNodeUse, string>>> | undefined,
  uses: MechanicalNodeUse,
): Promise<void> => {
  if (
    options.board === undefined ||
    change.taskId === undefined ||
    statuses === undefined
  ) {
    return;
  }
  await options.board.mirrorTaskStatus(
    change.taskId,
    boardStatusForMechanicalNode(input.blueprint, uses),
  );
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
      const statuses = await mirrorStatuses(input, options, change);
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
      await mirror(input, options, change, statuses, "prepare-worktree");
      return prepared;
    },
    "review-snapshot": async (input) => {
      const change = await requireChange(input);
      const statuses = await mirrorStatuses(input, options, change);
      const snapshot = await ensureReviewSnapshot(change, command);
      await mirror(input, options, change, statuses, "review-snapshot");
      return snapshot;
    },
    merge: async (input) => {
      const change = await requireChange(input);
      const snapshot = await requireSnapshotOutput(input);
      const statuses = await mirrorStatuses(input, options, change);
      const result = await mergeReviewSnapshot(change, snapshot, command);
      if (result.merged || result.alreadyMerged) {
        await mirror(input, options, change, statuses, "merge");
      }
      return result;
    },
    finalize: async (input) => {
      const change = await requireChange(input);
      const snapshot = await requireSnapshotOutput(input);
      const statuses = await mirrorStatuses(input, options, change);
      const result = await cleanupMergedChange(
        change,
        snapshot.snapshotId,
        command,
      );
      await mirror(input, options, change, statuses, "finalize");
      return result;
    },
  };
};
