// ---
// relationships:
//   implements: heddle
// ---

import { execFile } from "node:child_process";
import { join } from "node:path";

import type { JsonValue } from "../persistence/index.js";

export interface MechanicalChangeContext {
  baseBranch: string;
  branch: string;
  repositoryName: string;
  repositoryRoot: string;
  reviewDescription: string;
  reviewTitle: string;
  taskId?: number;
  worktreeName: string;
  worktreesRoot?: string;
}

export interface ReviewSnapshot extends Record<string, JsonValue> {
  baseBranch: string;
  baseHead: string;
  snapshotId: string;
  sourceBranch: string;
  sourceHead: string;
  status: "approved" | "open" | "rejected";
}

export type CommandRunner = (
  cwd: string,
  command: string,
  arguments_: string[],
) => Promise<string>;

export const defaultMechanicalCommand: CommandRunner = (
  cwd,
  command,
  arguments_,
) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      arguments_,
      { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });

export const mechanicalWorktreePath = (
  change: MechanicalChangeContext,
): string => {
  for (const [label, value] of [
    ["repositoryName", change.repositoryName],
    ["worktreeName", change.worktreeName],
  ] as const) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
      throw new TypeError(`${label} must be one safe path segment`);
    }
  }
  return join(
    change.worktreesRoot ?? "/workspaces/worktrees",
    change.repositoryName,
    change.worktreeName,
  );
};

export const runMechanicalGit = (
  command: CommandRunner,
  cwd: string,
  arguments_: string[],
): Promise<string> => command(cwd, "git", arguments_);

export const resolveMechanicalBranchHead = async (
  command: CommandRunner,
  repositoryRoot: string,
  branch: string,
): Promise<string | undefined> => {
  if (branch.trim() === "" || branch.startsWith("-") || branch === "HEAD") {
    throw new TypeError("branch must be a safe Git branch operand");
  }
  try {
    return (
      await runMechanicalGit(command, repositoryRoot, [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `refs/heads/${branch}^{commit}`,
      ])
    ).trim();
  } catch {
    return undefined;
  }
};

export const assertCleanMechanicalWorktree = async (
  command: CommandRunner,
  path: string,
): Promise<void> => {
  const status = await runMechanicalGit(command, path, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status !== "") {
    throw new Error(`Worktree ${JSON.stringify(path)} is dirty`);
  }
};

const topLevelScalar = (source: string, key: string): string => {
  const match = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(source);
  if (match?.[1] === undefined) {
    throw new Error(`gitpr snapshot is missing ${key}`);
  }
  const value = match[1].trim();
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value) as string;
  }
  return value;
};

export const readReviewSnapshot = async (
  repositoryRoot: string,
  snapshotId: string,
  command: CommandRunner,
): Promise<ReviewSnapshot> => {
  if (!/^[0-9A-Z]+$/.test(snapshotId)) {
    throw new TypeError("snapshotId must be an uppercase alphanumeric ID");
  }
  const source = await runMechanicalGit(command, repositoryRoot, [
    "show",
    `refs/gitpr/pr/${snapshotId}/meta:pr.yaml`,
  ]);
  const status = topLevelScalar(source, "status");
  if (status !== "open" && status !== "approved" && status !== "rejected") {
    throw new Error(
      `gitpr snapshot has invalid status ${JSON.stringify(status)}`,
    );
  }
  return {
    baseBranch: topLevelScalar(source, "base_branch"),
    baseHead: topLevelScalar(source, "base_head_sha"),
    snapshotId: topLevelScalar(source, "id"),
    sourceBranch: topLevelScalar(source, "source_branch"),
    sourceHead: topLevelScalar(source, "source_head_sha"),
    status,
  };
};

export const assertReviewSnapshotMatches = (
  change: MechanicalChangeContext,
  snapshot: ReviewSnapshot,
): void => {
  if (
    snapshot.sourceBranch !== change.branch ||
    snapshot.baseBranch !== change.baseBranch
  ) {
    throw new Error(
      `Snapshot ${snapshot.snapshotId} does not describe the configured change`,
    );
  }
};

const matchingOpenSnapshot = async (
  change: MechanicalChangeContext,
  sourceHead: string,
  baseHead: string,
  command: CommandRunner,
): Promise<ReviewSnapshot | undefined> => {
  const refs = await runMechanicalGit(command, change.repositoryRoot, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/gitpr/pr",
  ]);
  const ids = [
    ...new Set(
      refs
        .split("\n")
        .map((ref) => /^refs\/gitpr\/pr\/([^/]+)\/meta$/.exec(ref)?.[1])
        .filter((id): id is string => id !== undefined),
    ),
  ].sort();
  const snapshots = await Promise.all(
    ids.map((id) => readReviewSnapshot(change.repositoryRoot, id, command)),
  );
  return snapshots.find(
    (snapshot) =>
      snapshot.status === "open" &&
      snapshot.sourceBranch === change.branch &&
      snapshot.sourceHead === sourceHead &&
      snapshot.baseBranch === change.baseBranch &&
      snapshot.baseHead === baseHead,
  );
};

export const ensureReviewSnapshot = async (
  change: MechanicalChangeContext,
  command: CommandRunner = defaultMechanicalCommand,
): Promise<ReviewSnapshot> => {
  const path = mechanicalWorktreePath(change);
  await assertCleanMechanicalWorktree(command, path);
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
  if (sourceHead === undefined || baseHead === undefined) {
    throw new Error("Review source and base branches must exist");
  }
  const existing = await matchingOpenSnapshot(
    change,
    sourceHead,
    baseHead,
    command,
  );
  if (existing !== undefined) return existing;

  const output = await command(change.repositoryRoot, "gitpr", [
    "create",
    "--worktree",
    path,
    "--base",
    change.baseBranch,
    "--title",
    change.reviewTitle,
    "--description",
    change.reviewDescription,
  ]);
  const snapshotId = /^Created PR ([0-9A-Z]+)\b/m.exec(output)?.[1];
  if (snapshotId === undefined) {
    throw new Error("gitpr create did not report a snapshot ID");
  }
  const created = await readReviewSnapshot(
    change.repositoryRoot,
    snapshotId,
    command,
  );
  assertReviewSnapshotMatches(change, created);
  if (created.sourceHead !== sourceHead || created.baseHead !== baseHead) {
    throw new Error("gitpr snapshot identities changed during creation");
  }
  return created;
};
