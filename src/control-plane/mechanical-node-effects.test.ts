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

import { afterEach, describe, expect, it } from "vitest";

import { LifecycleEngine, UnexpectedLandingError } from "../engine/index.js";
import { SqlitePersistence } from "../persistence/index.js";
import { ensureWorktree } from "./worktree-creator.js";
import {
  cleanupMergedChange,
  createMechanicalNodeEffects,
  ensureReviewSnapshot,
  mechanicalChangeContextKey,
  mergeReviewSnapshot,
  type MechanicalChangeContext,
  type MechanicalNodeEffectOptions,
} from "./mechanical-node-effects.js";

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];

const git = async (cwd: string, ...arguments_: string[]): Promise<string> =>
  (await execute("git", arguments_, { cwd })).stdout;

const makeChange = async (): Promise<{
  change: MechanicalChangeContext;
  sourcePath: string;
  worktreePath: string;
}> => {
  const root = await mkdtemp(join(tmpdir(), "heddle-mechanics-"));
  temporaryDirectories.push(root);
  const sourcePath = join(root, "source");
  const worktreesRoot = join(root, "worktrees");
  const worktreePath = join(worktreesRoot, "sample-repository", "task-change");
  await mkdir(sourcePath);
  await git(sourcePath, "init", "--quiet", "--initial-branch=main");
  await git(sourcePath, "config", "user.email", "test@example.invalid");
  await git(sourcePath, "config", "user.name", "Test Operator");
  await writeFile(join(sourcePath, "inventory.txt"), "one\n");
  await git(sourcePath, "add", "inventory.txt");
  await git(sourcePath, "commit", "--quiet", "-m", "initial inventory");
  return {
    change: {
      baseBranch: "main",
      branch: "task/change",
      repositoryName: "sample-repository",
      repositoryRoot: sourcePath,
      reviewDescription: "Record the second inventory item.",
      reviewTitle: "Record inventory item",
      worktreeName: "task-change",
      worktreesRoot,
    },
    sourcePath,
    worktreePath,
  };
};

const prepareCommittedChange = async () => {
  const fixture = await makeChange();
  const input = {
    baseRef: fixture.change.baseBranch,
    branch: fixture.change.branch,
    repositoryName: fixture.change.repositoryName,
    repositoryRoot: fixture.change.repositoryRoot,
    worktreeName: fixture.change.worktreeName,
    worktreesRoot: fixture.change.worktreesRoot,
  };
  const first = await ensureWorktree(input);
  const second = await ensureWorktree(input);
  await writeFile(join(fixture.worktreePath, "inventory.txt"), "one\ntwo\n");
  await git(fixture.worktreePath, "add", "inventory.txt");
  await git(fixture.worktreePath, "commit", "--quiet", "-m", "add item");
  return { ...fixture, prepared: [first, second] };
};

const makeLifecycle = async (
  options: MechanicalNodeEffectOptions = {},
  taskId?: number,
) => {
  const fixture = await makeChange();
  fixture.change.taskId = taskId;
  await mkdir(join(fixture.sourcePath, "blueprints"));
  await copyFile(
    "blueprints/standard-delivery.json",
    join(fixture.sourcePath, "blueprints", "standard-delivery.json"),
  );
  await git(fixture.sourcePath, "add", "blueprints/standard-delivery.json");
  await git(fixture.sourcePath, "commit", "--quiet", "-m", "add lifecycle");
  const persistence = new SqlitePersistence({
    stateDirectory: join(fixture.sourcePath, "..", "state"),
  });
  const engine = new LifecycleEngine({
    effects: createMechanicalNodeEffects(options),
    persistence,
    repositoryRoot: fixture.sourcePath,
  });
  await engine.start({
    blueprintPath: "blueprints/standard-delivery.json",
    initialContext: {
      [mechanicalChangeContextKey]: fixture.change,
    },
    instanceId: "sample-lifecycle",
  });
  await writeFile(join(fixture.worktreePath, "inventory.txt"), "one\ntwo\n");
  await git(fixture.worktreePath, "add", "inventory.txt");
  await git(fixture.worktreePath, "commit", "--quiet", "-m", "add item");
  await engine.resume({
    disposition: "complete",
    instanceId: "sample-lifecycle",
    operationId: "implementation-complete",
  });
  return { ...fixture, engine, persistence };
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("delivery mechanical nodes", () => {
  it("re-runs worktree, snapshot, merge, and cleanup effects without duplicates", async () => {
    const fixture = await prepareCommittedChange();
    expect(fixture.prepared.map(({ created }) => created)).toEqual([
      true,
      false,
    ]);

    const firstSnapshot = await ensureReviewSnapshot(fixture.change);
    const secondSnapshot = await ensureReviewSnapshot(fixture.change);
    expect(secondSnapshot).toEqual(firstSnapshot);
    expect(
      (
        await git(
          fixture.sourcePath,
          "for-each-ref",
          "--format=%(refname)",
          "refs/gitpr/pr",
        )
      )
        .split("\n")
        .filter((ref) => ref.endsWith("/meta")),
    ).toHaveLength(1);

    const firstMerge = await mergeReviewSnapshot(
      fixture.change,
      firstSnapshot.snapshotId,
    );
    const secondMerge = await mergeReviewSnapshot(
      fixture.change,
      firstSnapshot.snapshotId,
    );
    expect(firstMerge).toMatchObject({ merged: true, alreadyMerged: false });
    expect(secondMerge).toMatchObject({ merged: false, alreadyMerged: true });
    expect(await git(fixture.sourcePath, "rev-list", "--merges", "main")).toBe(
      "",
    );

    const firstCleanup = await cleanupMergedChange(
      fixture.change,
      firstSnapshot.snapshotId,
    );
    const secondCleanup = await cleanupMergedChange(
      fixture.change,
      firstSnapshot.snapshotId,
    );
    expect(firstCleanup).toEqual({
      branchDeleted: true,
      snapshotId: firstSnapshot.snapshotId,
      worktreeRemoved: true,
    });
    expect(secondCleanup).toEqual({
      branchDeleted: false,
      snapshotId: firstSnapshot.snapshotId,
      worktreeRemoved: false,
    });
    await expect(lstat(fixture.worktreePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      git(
        fixture.sourcePath,
        "show-ref",
        "--verify",
        "--quiet",
        "refs/heads/task/change",
      ),
    ).rejects.toThrow();
  });

  it("routes source-head drift to remediation without merging", async () => {
    const fixture = await prepareCommittedChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    const baseBefore = await git(fixture.sourcePath, "rev-parse", "main");
    await writeFile(join(fixture.worktreePath, "notes.txt"), "checked\n");
    await git(fixture.worktreePath, "add", "notes.txt");
    await git(fixture.worktreePath, "commit", "--quiet", "-m", "add note");

    await expect(
      mergeReviewSnapshot(fixture.change, snapshot.snapshotId),
    ).resolves.toEqual({
      alreadyMerged: false,
      dispositions: { merged: false, remediate: true },
      merged: false,
      snapshotId: snapshot.snapshotId,
    });
    expect(await git(fixture.sourcePath, "rev-parse", "main")).toBe(baseBefore);
  });

  it("fails a conflicting merge and preserves both branch heads", async () => {
    const fixture = await prepareCommittedChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    await writeFile(join(fixture.sourcePath, "inventory.txt"), "replacement\n");
    await git(fixture.sourcePath, "add", "inventory.txt");
    await git(fixture.sourcePath, "commit", "--quiet", "-m", "replace item");
    const baseHead = await git(fixture.sourcePath, "rev-parse", "main");
    const sourceHead = await git(
      fixture.sourcePath,
      "rev-parse",
      "task/change",
    );

    await expect(
      mergeReviewSnapshot(fixture.change, snapshot.snapshotId),
    ).rejects.toThrow();
    expect(await git(fixture.sourcePath, "rev-parse", "main")).toBe(baseHead);
    expect(await git(fixture.sourcePath, "rev-parse", "task/change")).toBe(
      sourceHead,
    );
  });

  it("refuses cleanup while the merged worktree is dirty", async () => {
    const fixture = await prepareCommittedChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    await mergeReviewSnapshot(fixture.change, snapshot.snapshotId);
    await writeFile(join(fixture.worktreePath, "local.txt"), "uncommitted\n");

    await expect(
      cleanupMergedChange(fixture.change, snapshot.snapshotId),
    ).rejects.toThrow(/dirty/);
    await expect(lstat(fixture.worktreePath)).resolves.toBeDefined();
    expect(await git(fixture.sourcePath, "rev-parse", "task/change")).toBe(
      snapshot.sourceHead + "\n",
    );
  });

  it("preserves a clean worktree when the merged branch moved", async () => {
    const fixture = await prepareCommittedChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    await mergeReviewSnapshot(fixture.change, snapshot.snapshotId);
    await writeFile(join(fixture.worktreePath, "notes.txt"), "later\n");
    await git(fixture.worktreePath, "add", "notes.txt");
    await git(fixture.worktreePath, "commit", "--quiet", "-m", "later note");
    const movedHead = await git(fixture.sourcePath, "rev-parse", "task/change");

    await expect(
      cleanupMergedChange(fixture.change, snapshot.snapshotId),
    ).rejects.toThrow(/moved/);
    await expect(lstat(fixture.worktreePath)).resolves.toBeDefined();
    expect(await git(fixture.sourcePath, "rev-parse", "task/change")).toBe(
      movedHead,
    );
  });

  it("rejects path traversal before running a mechanical command", async () => {
    const fixture = await makeChange();
    let commands = 0;

    await expect(
      ensureReviewSnapshot(
        { ...fixture.change, repositoryName: "../outside" },
        async () => {
          commands += 1;
          throw new Error("command must not run");
        },
      ),
    ).rejects.toThrow(/safe path segment/);
    expect(commands).toBe(0);
  });

  it("routes real snapshot drift through the lifecycle remediation wait", async () => {
    const fixture = await makeLifecycle();
    await writeFile(join(fixture.worktreePath, "notes.txt"), "checked\n");
    await git(fixture.worktreePath, "add", "notes.txt");
    await git(fixture.worktreePath, "commit", "--quiet", "-m", "add note");

    const remediation = await fixture.engine.resume({
      disposition: "approve",
      instanceId: "sample-lifecycle",
      operationId: "review-approved",
    });

    expect(remediation).toMatchObject({
      awaitingNodeIds: ["remediate"],
      status: "awaiting",
    });
    expect(
      fixture.persistence
        .replayEvents("sample-lifecycle")
        .filter(({ type }) => type === "lifecycle:attention-required"),
    ).toHaveLength(0);
    fixture.persistence.close();
  });

  it("moves a real merge conflict to attention without entering remediation", async () => {
    const fixture = await makeLifecycle();
    await writeFile(join(fixture.sourcePath, "inventory.txt"), "replacement\n");
    await git(fixture.sourcePath, "add", "inventory.txt");
    await git(fixture.sourcePath, "commit", "--quiet", "-m", "replace item");

    await expect(
      fixture.engine.resume({
        disposition: "approve",
        instanceId: "sample-lifecycle",
        operationId: "review-approved",
      }),
    ).rejects.toBeInstanceOf(UnexpectedLandingError);
    expect(
      fixture.persistence
        .replayEvents("sample-lifecycle")
        .filter(({ type }) => type === "lifecycle:attention-required"),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ actualStatus: "failed" }),
      }),
    ]);
    expect(
      fixture.persistence.getInstance("sample-lifecycle")?.state
        .flowcraftContext,
    ).toMatchObject({ awaitingNodeIds: ["review"] });
    fixture.persistence.close();
  });

  it("moves dirty finalization to attention after an exact-head merge", async () => {
    const fixture = await makeLifecycle();
    const retrospective = await fixture.engine.resume({
      disposition: "approve",
      instanceId: "sample-lifecycle",
      operationId: "review-approved",
    });
    expect(retrospective.awaitingNodeIds).toEqual(["retrospective"]);
    await writeFile(join(fixture.worktreePath, "local.txt"), "uncommitted\n");

    await expect(
      fixture.engine.resume({
        disposition: "complete",
        instanceId: "sample-lifecycle",
        operationId: "retrospective-complete",
      }),
    ).rejects.toBeInstanceOf(UnexpectedLandingError);
    expect(
      fixture.persistence
        .replayEvents("sample-lifecycle")
        .filter(({ type }) => type === "lifecycle:attention-required"),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ actualStatus: "failed" }),
      }),
    ]);
    await expect(lstat(fixture.worktreePath)).resolves.toBeDefined();
    fixture.persistence.close();
  });

  it("mirrors each completed mechanical stage through the board adapter", async () => {
    const mirrored: Array<{ status: string; taskId: number }> = [];
    const fixture = await makeLifecycle(
      {
        board: {
          mirrorChildStatus: async (taskId, status) => {
            mirrored.push({ status, taskId });
          },
        },
        statuses: {
          completed: "done",
          inProgress: "in-progress",
          merged: "retrospective",
          review: "review",
        },
      },
      12,
    );

    await fixture.engine.resume({
      disposition: "approve",
      instanceId: "sample-lifecycle",
      operationId: "review-approved",
    });
    await fixture.engine.resume({
      disposition: "complete",
      instanceId: "sample-lifecycle",
      operationId: "retrospective-complete",
    });

    expect(mirrored).toEqual([
      { status: "in-progress", taskId: 12 },
      { status: "review", taskId: 12 },
      { status: "retrospective", taskId: 12 },
      { status: "done", taskId: 12 },
    ]);
    fixture.persistence.close();
  });
});
