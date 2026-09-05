// ---
// relationships:
//   implements: heddle
// ---

import { execFile } from "node:child_process";
import { join } from "node:path";
import { parse } from "yaml";

import type { JsonValue } from "../persistence/index.js";
import { ensureWorktree } from "./worktree-creator.js";

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
  latestEvent: ReviewSnapshotEvent | null;
  schema: 2;
  snapshotId: string;
  sourceBranch: string;
  sourceHead: string;
  state: "closed" | "merged" | "open";
}

export interface ReviewSnapshotEvent extends Record<string, JsonValue> {
  baseHead: string;
  eventId: string;
  mergeBase: string;
  sourceHead: string;
  verdict: "accepted" | "rejected";
}

export type CommandRunner = (
  cwd: string,
  command: string,
  arguments_: string[],
  input?: string,
) => Promise<string>;

export const defaultMechanicalCommand: CommandRunner = (
  cwd,
  command,
  arguments_,
  input,
) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      command,
      arguments_,
      { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
    if (input !== undefined) child.stdin?.end(input);
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
    change.worktreeName,
    change.repositoryName,
  );
};

export const runMechanicalGit = (
  command: CommandRunner,
  cwd: string,
  arguments_: string[],
  input?: string,
): Promise<string> => command(cwd, "git", arguments_, input);

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
  } catch (error) {
    if ((error as { code?: number | string }).code === 1) return undefined;
    throw error;
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

interface GitprReviewRecord {
  baseBranch: string;
  events: ReviewSnapshotEvent[];
  mergedEventId?: string;
  schema: 2;
  snapshotId: string;
  sourceBranch: string;
  state: ReviewSnapshot["state"];
}

type GitprReviewMetadata = Pick<
  GitprReviewRecord,
  "baseBranch" | "schema" | "snapshotId" | "sourceBranch" | "state"
>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requiredString = (
  value: Record<string, unknown>,
  key: string,
): string => {
  const result = value[key];
  if (typeof result !== "string" || result === "") {
    throw new Error(`gitpr snapshot is missing ${key}`);
  }
  return result;
};

const requiredObjectId = (
  value: Record<string, unknown>,
  key: string,
): string => {
  const result = requiredString(value, key);
  if (!isReviewObjectId(result)) {
    throw new Error(
      `gitpr snapshot has invalid ${key} ${JSON.stringify(result)}`,
    );
  }
  return result;
};

export const isReviewObjectId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

const parseReviewRecord = (
  source: string,
  unsupportedSchema: "reject" | "skip",
): GitprReviewRecord | undefined => {
  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch (error) {
    throw new Error(
      `gitpr snapshot is invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isObject(parsed)) throw new Error("gitpr snapshot is not an object");
  if (parsed["schema"] !== 2) {
    if (unsupportedSchema === "skip") return undefined;
    throw new Error(
      `gitpr snapshot has unsupported schema ${JSON.stringify(parsed["schema"])}`,
    );
  }
  const state = requiredString(parsed, "state");
  if (state !== "open" && state !== "merged" && state !== "closed") {
    throw new Error(
      `gitpr snapshot has invalid state ${JSON.stringify(state)}`,
    );
  }
  const eventsValue = parsed["events"];
  if (eventsValue !== undefined && !Array.isArray(eventsValue)) {
    throw new Error("gitpr snapshot has invalid events");
  }
  const events = (eventsValue ?? []).map((value, index) => {
    if (!isObject(value)) {
      throw new Error(`gitpr snapshot event ${index} is not an object`);
    }
    const verdict = requiredString(value, "verdict");
    if (verdict !== "accepted" && verdict !== "rejected") {
      throw new Error(
        `gitpr snapshot event ${index} has invalid verdict ${JSON.stringify(verdict)}`,
      );
    }
    return {
      baseHead: requiredObjectId(value, "base_head_sha"),
      eventId: requiredString(value, "id"),
      mergeBase: requiredObjectId(value, "merge_base_sha"),
      sourceHead: requiredObjectId(value, "source_head_sha"),
      verdict,
    } satisfies ReviewSnapshotEvent;
  });
  const mergedEventId = parsed["merged_event_id"];
  if (mergedEventId !== undefined && typeof mergedEventId !== "string") {
    throw new Error("gitpr snapshot has invalid merged_event_id");
  }
  return {
    baseBranch: requiredString(parsed, "base_branch"),
    events,
    ...(mergedEventId === undefined ? {} : { mergedEventId }),
    schema: 2,
    snapshotId: requiredString(parsed, "id"),
    sourceBranch: requiredString(parsed, "source_branch"),
    state,
  };
};

const readReviewRecord = async (
  repositoryRoot: string,
  snapshotId: string,
  command: CommandRunner,
): Promise<GitprReviewRecord> => {
  const source = await runMechanicalGit(command, repositoryRoot, [
    "show",
    `refs/gitpr/pr/${snapshotId}/meta:pr.yaml`,
  ]);
  return parseReviewRecord(source, "reject")!;
};

const readReviewMetadataIfSupported = async (
  repositoryRoot: string,
  snapshotId: string,
  metaVersion: string,
  command: CommandRunner,
): Promise<GitprReviewMetadata | undefined> => {
  let source: string;
  try {
    source = await runMechanicalGit(command, repositoryRoot, [
      "grep",
      "-E",
      "^(schema|id|source_branch|base_branch|state):",
      metaVersion,
      "--",
      "pr.yaml",
    ]);
  } catch (error) {
    if ((error as { code?: number | string }).code === 1) return undefined;
    throw error;
  }
  const prefix = `${metaVersion}:pr.yaml:`;
  const projected = source
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      if (!line.startsWith(prefix)) {
        throw new Error(
          `gitpr snapshot ${JSON.stringify(snapshotId)} returned invalid metadata`,
        );
      }
      return line.slice(prefix.length);
    })
    .join("\n");
  let parsed: unknown;
  try {
    parsed = parse(projected);
  } catch (error) {
    throw new Error(
      `gitpr snapshot metadata is invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isObject(parsed) || parsed["schema"] !== 2) return undefined;
  const state = requiredString(parsed, "state");
  if (state !== "open" && state !== "merged" && state !== "closed") {
    throw new Error(
      `gitpr snapshot has invalid state ${JSON.stringify(state)}`,
    );
  }
  return {
    baseBranch: requiredString(parsed, "base_branch"),
    schema: 2,
    snapshotId: requiredString(parsed, "id"),
    sourceBranch: requiredString(parsed, "source_branch"),
    state,
  };
};

const reviewSnapshotFromRecord = (
  record: GitprReviewRecord,
  sourceHead: string,
  baseHead: string,
): ReviewSnapshot => ({
  baseBranch: record.baseBranch,
  baseHead,
  latestEvent: record.events.at(-1) ?? null,
  schema: 2,
  snapshotId: record.snapshotId,
  sourceBranch: record.sourceBranch,
  sourceHead,
  state: record.state,
});

export const readReviewSnapshot = async (
  repositoryRoot: string,
  snapshotId: string,
  command: CommandRunner,
): Promise<ReviewSnapshot> => {
  if (!/^[0-9A-Z]+$/.test(snapshotId)) {
    throw new TypeError("snapshotId must be an uppercase alphanumeric ID");
  }
  const record = await readReviewRecord(repositoryRoot, snapshotId, command);
  if (record.snapshotId !== snapshotId) {
    throw new Error("gitpr snapshot ID does not match its ref");
  }
  const mergedEvent =
    record.state === "merged"
      ? record.events.find(({ eventId }) => eventId === record.mergedEventId)
      : undefined;
  if (record.state === "merged") {
    if (mergedEvent === undefined || mergedEvent.verdict !== "accepted") {
      throw new Error("gitpr merged snapshot has no accepted merged event");
    }
    return reviewSnapshotFromRecord(
      record,
      mergedEvent.sourceHead,
      mergedEvent.baseHead,
    );
  }
  const [sourceHead, baseHead] = await Promise.all([
    resolveMechanicalBranchHead(command, repositoryRoot, record.sourceBranch),
    resolveMechanicalBranchHead(command, repositoryRoot, record.baseBranch),
  ]);
  if (sourceHead === undefined || baseHead === undefined) {
    throw new Error("Review source and base branches must exist");
  }
  return reviewSnapshotFromRecord(record, sourceHead, baseHead);
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
    "--format=%(refname)%09%(objectname)",
    "refs/gitpr/index/open",
  ]);
  const indexed = refs
    .split("\n")
    .map((line) =>
      /^refs\/gitpr\/index\/open\/([0-9A-Z]+)\t([0-9a-f]{40})$/.exec(line),
    )
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ id: match[1]!, metaVersion: match[2]! }))
    .sort(({ id: left }, { id: right }) => left.localeCompare(right));
  for (const { id, metaVersion } of indexed) {
    const metadata = await readReviewMetadataIfSupported(
      change.repositoryRoot,
      id,
      metaVersion,
      command,
    );
    if (
      metadata?.state !== "open" ||
      metadata.sourceBranch !== change.branch ||
      metadata.baseBranch !== change.baseBranch
    ) {
      continue;
    }
    if (metadata.snapshotId !== id) {
      throw new Error("gitpr snapshot ID does not match its ref");
    }
    const record = parseReviewRecord(
      await runMechanicalGit(command, change.repositoryRoot, [
        "show",
        `${metaVersion}:pr.yaml`,
      ]),
      "reject",
    )!;
    if (
      record.snapshotId !== id ||
      record.state !== metadata.state ||
      record.sourceBranch !== metadata.sourceBranch ||
      record.baseBranch !== metadata.baseBranch
    ) {
      throw new Error("gitpr snapshot metadata does not match its record");
    }
    return reviewSnapshotFromRecord(record, sourceHead, baseHead);
  }
  return undefined;
};

export const ensureReviewSnapshot = async (
  change: MechanicalChangeContext,
  command: CommandRunner = defaultMechanicalCommand,
): Promise<ReviewSnapshot> => {
  const path = mechanicalWorktreePath(change);
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
