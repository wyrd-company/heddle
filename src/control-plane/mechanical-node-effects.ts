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
import type { JsonValue } from "../persistence/index.js";

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

const requireChanges = async (
  input: LifecycleEffectInput,
): Promise<MechanicalChangeContext[]> => {
  const value = await input.context.get(mechanicalChangeContextKey);
  if (typeof value !== "object" || value === null) {
    throw new Error("Mechanical change context is missing");
  }
  const changes = (
    Array.isArray(value) ? value : [value]
  ) as Partial<MechanicalChangeContext>[];
  if (changes.length === 0) {
    throw new Error("Mechanical change context has no repositories");
  }
  for (const change of changes) {
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
  }
  return changes as MechanicalChangeContext[];
};

/**
 * The snapshot a merge lands and a finalize cleans up is the output of the
 * pinned blueprint's review-snapshot node, whatever that node is called.
 */
const requireSnapshotOutputs = async (
  input: LifecycleEffectInput,
): Promise<ReviewSnapshot[]> => {
  const snapshotNodeIds = input.blueprint.nodes
    .filter(({ uses }) => uses === "review-snapshot")
    .map(({ id }) => id);
  const outputs: Array<[string, unknown]> = [];
  for (const nodeId of snapshotNodeIds) {
    const output = await input.context.get(`_outputs.${nodeId}`);
    if (typeof output === "object" && output !== null) {
      outputs.push([nodeId, output]);
    }
  }
  if (outputs.length === 0) {
    throw new Error(
      `Review snapshot output is missing; review-snapshot nodes: ${JSON.stringify(snapshotNodeIds)}`,
    );
  }
  if (outputs.length > 1) {
    throw new Error(
      `Several review-snapshot nodes have outputs: ${JSON.stringify(outputs.map(([nodeId]) => nodeId))}`,
    );
  }
  const value = outputs[0]![1];
  const snapshots = (
    Array.isArray(value) ? value : [value]
  ) as Partial<ReviewSnapshot>[];
  if (snapshots.length === 0) {
    throw new Error("Review snapshot output has no repositories");
  }
  for (const snapshot of snapshots) {
    if (typeof snapshot.snapshotId !== "string") {
      throw new Error("Review snapshot output is missing snapshotId");
    }
    for (const key of ["sourceHead", "baseHead"] as const) {
      if (!isReviewObjectId(snapshot[key])) {
        throw new Error(`Review snapshot output has invalid ${key}`);
      }
    }
  }
  return snapshots as ReviewSnapshot[];
};

const oneOrMany = <T>(values: T[]): T | T[] =>
  values.length === 1 ? values[0]! : values;

const mergedRepositoryResults = (
  changes: readonly MechanicalChangeContext[],
  results: readonly MergeSnapshotResult[],
): JsonValue => {
  if (results.length === 1) return results[0]!;
  const remediationIndex = results.findIndex(
    ({ dispositions }) => dispositions.remediate,
  );
  if (remediationIndex >= 0) {
    const remediation = results[remediationIndex]!;
    if (!remediation.dispositions.remediate) {
      throw new Error("Mechanical merge remediation result is inconsistent");
    }
    const remediationCause = remediation.remediationCause as
      ReviewIntegrationRemediationCause | undefined;
    if (remediationCause === undefined) {
      throw new Error("Mechanical merge remediation cause is missing");
    }
    return {
      dispositions: { merged: false, remediate: true },
      remediationCause: {
        ...remediationCause,
        repositoryName: changes[remediationIndex]!.repositoryName,
      },
      repositories: [...results],
    };
  }
  return {
    dispositions: { merged: true, remediate: false },
    repositories: [...results],
  };
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
      const changes = await requireChanges(input);
      const statuses = await mirrorStatuses(input, options, changes[0]!);
      const prepared = [];
      for (const change of changes) {
        prepared.push(
          await ensureWorktree(
            {
              baseRef: change.baseBranch,
              branch: change.branch,
              repositoryName: change.repositoryName,
              repositoryRoot: change.repositoryRoot,
              worktreeName: change.worktreeName,
              worktreesRoot: change.worktreesRoot,
            },
            git,
          ),
        );
      }
      await mirror(input, options, changes[0]!, statuses, "prepare-worktree");
      return oneOrMany(prepared);
    },
    "review-snapshot": async (input) => {
      const changes = await requireChanges(input);
      const statuses = await mirrorStatuses(input, options, changes[0]!);
      const snapshots = [];
      for (const change of changes) {
        snapshots.push(await ensureReviewSnapshot(change, command));
      }
      await mirror(input, options, changes[0]!, statuses, "review-snapshot");
      return oneOrMany(snapshots);
    },
    merge: async (input) => {
      const changes = await requireChanges(input);
      const snapshots = await requireSnapshotOutputs(input);
      if (snapshots.length !== changes.length) {
        throw new Error(
          "Review snapshot output does not match repository scope",
        );
      }
      const statuses = await mirrorStatuses(input, options, changes[0]!);
      const results = [];
      for (const [index, change] of changes.entries()) {
        results.push(
          await mergeReviewSnapshot(change, snapshots[index]!, command),
        );
      }
      if (results.every((result) => result.merged || result.alreadyMerged)) {
        await mirror(input, options, changes[0]!, statuses, "merge");
      }
      return mergedRepositoryResults(changes, results);
    },
    finalize: async (input) => {
      const changes = await requireChanges(input);
      const snapshots = await requireSnapshotOutputs(input);
      if (snapshots.length !== changes.length) {
        throw new Error(
          "Review snapshot output does not match repository scope",
        );
      }
      const statuses = await mirrorStatuses(input, options, changes[0]!);
      const results = [];
      for (const [index, change] of changes.entries()) {
        results.push(
          await cleanupMergedChange(
            change,
            snapshots[index]!.snapshotId,
            command,
          ),
        );
      }
      await mirror(input, options, changes[0]!, statuses, "finalize");
      return oneOrMany(results);
    },
  };
};
