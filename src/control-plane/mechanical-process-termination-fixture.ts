// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect } from "vitest";

import { LifecycleEngine, type ResumeLifecycleInput } from "../engine/index.js";
import { SqlitePersistence } from "../persistence/index.js";
import {
  createMechanicalNodeEffects,
  mechanicalChangeContextKey,
} from "./mechanical-node-effects.js";
import {
  defaultMechanicalCommand,
  readReviewSnapshot,
  type MechanicalChangeContext,
  type ReviewSnapshot,
} from "./review-snapshot.js";

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];

export interface LifecycleFixture {
  approvalWorktreePath: string;
  change: MechanicalChangeContext;
  repositoryRoot: string;
  snapshot: ReviewSnapshot;
  sourceWorktreePath: string;
  stateDirectory: string;
}

export const git = async (
  cwd: string,
  ...arguments_: string[]
): Promise<string> => (await execute("git", arguments_, { cwd })).stdout;

export const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
};

export const readBranchHead = async (
  repositoryRoot: string,
  branch: string,
): Promise<string | undefined> => {
  try {
    return (
      await git(
        repositoryRoot,
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${branch}^{commit}`,
      )
    ).trim();
  } catch (error) {
    if ((error as { code?: number }).code === 1) return undefined;
    throw error;
  }
};

export const makeLifecycleAtReview = async (
  detachBase = false,
): Promise<LifecycleFixture> => {
  const root = await mkdtemp(join(tmpdir(), "heddle-termination-"));
  temporaryDirectories.push(root);
  const repositoryRoot = join(root, "source");
  const stateDirectory = join(root, "state");
  const worktreesRoot = join(root, "worktrees");
  await mkdir(join(repositoryRoot, "blueprints"), { recursive: true });
  await git(repositoryRoot, "init", "--quiet", "--initial-branch=main");
  await git(repositoryRoot, "config", "user.email", "fixture@example.invalid");
  await git(repositoryRoot, "config", "user.name", "Fixture Operator");
  await writeFile(join(repositoryRoot, "inventory.txt"), "one\n");
  await copyFile(
    "blueprints/standard-delivery.json",
    join(repositoryRoot, "blueprints", "standard-delivery.json"),
  );
  await git(repositoryRoot, "add", ".");
  await git(repositoryRoot, "commit", "--quiet", "-m", "add initial item");

  const change: MechanicalChangeContext = {
    baseBranch: "main",
    branch: "feature/add-item",
    repositoryName: "sample-repository",
    repositoryRoot,
    reviewDescription: "Record another inventory item.",
    reviewTitle: "Record inventory item",
    worktreeName: "item-update",
    worktreesRoot,
  };
  const sourceWorktreePath = join(
    worktreesRoot,
    change.worktreeName,
    change.repositoryName,
  );
  const approvalWorktreePath = join(
    worktreesRoot,
    `${change.worktreeName}.merge-base`,
    change.repositoryName,
  );
  const persistence = new SqlitePersistence({ stateDirectory });
  const engine = new LifecycleEngine({
    effects: createMechanicalNodeEffects(),
    persistence,
    repositoryRoot,
  });
  await engine.start({
    blueprintPath: "blueprints/standard-delivery.json",
    initialContext: { [mechanicalChangeContextKey]: { ...change } },
    instanceId: "sample-lifecycle",
  });
  await writeFile(join(sourceWorktreePath, "inventory.txt"), "one\ntwo\n");
  await git(sourceWorktreePath, "add", "inventory.txt");
  await git(sourceWorktreePath, "commit", "--quiet", "-m", "add item");
  const review = await engine.resume({
    disposition: "complete",
    instanceId: "sample-lifecycle",
    operationId: "implementation-complete",
  });
  expect(review).toMatchObject({
    awaitingNodeIds: ["review"],
    status: "awaiting",
  });
  const snapshotRefs = await git(
    repositoryRoot,
    "for-each-ref",
    "--format=%(refname)",
    "refs/gitpr/pr",
  );
  const snapshotId = /^refs\/gitpr\/pr\/([^/]+)\/meta$/m.exec(
    snapshotRefs,
  )?.[1];
  if (snapshotId === undefined)
    throw new Error("Review snapshot was not created");
  const snapshot = await readReviewSnapshot(
    repositoryRoot,
    snapshotId,
    defaultMechanicalCommand,
  );
  persistence.close();
  if (detachBase) await git(repositoryRoot, "switch", "--detach");
  return {
    approvalWorktreePath,
    change,
    repositoryRoot,
    snapshot,
    sourceWorktreePath,
    stateDirectory,
  };
};

export const makeLifecycleAtRetrospective =
  async (): Promise<LifecycleFixture> => {
    const fixture = await makeLifecycleAtReview();
    const persistence = new SqlitePersistence({
      stateDirectory: fixture.stateDirectory,
    });
    const engine = new LifecycleEngine({
      effects: createMechanicalNodeEffects(),
      persistence,
      repositoryRoot: fixture.repositoryRoot,
    });
    const retrospective = await engine.resume({
      disposition: "approve",
      instanceId: "sample-lifecycle",
      operationId: "review-approved",
    });
    expect(retrospective).toMatchObject({
      awaitingNodeIds: ["retrospective"],
      status: "awaiting",
    });
    persistence.close();
    return fixture;
  };

export const mergeResume: ResumeLifecycleInput = {
  disposition: "approve",
  instanceId: "sample-lifecycle",
  operationId: "review-approved",
};

export const cleanupResume: ResumeLifecycleInput = {
  disposition: "complete",
  instanceId: "sample-lifecycle",
  operationId: "retrospective-complete",
};

export const snapshotNow = (
  fixture: LifecycleFixture,
): Promise<ReviewSnapshot> =>
  readReviewSnapshot(
    fixture.repositoryRoot,
    fixture.snapshot.snapshotId,
    defaultMechanicalCommand,
  );

export const assertOwnedWorktree = async (
  fixture: LifecycleFixture,
  path: string,
  branch: string,
): Promise<void> => {
  expect(await git(path, "symbolic-ref", "--quiet", "--short", "HEAD")).toBe(
    `${branch}\n`,
  );
  expect(
    (
      await git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")
    ).trim(),
  ).toBe(
    (
      await git(
        fixture.repositoryRoot,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      )
    ).trim(),
  );
};

export const cleanupTerminationFixtures = async (): Promise<void> => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
};
