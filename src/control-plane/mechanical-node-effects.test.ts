// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { LifecycleEngine, UnexpectedLandingError } from "../engine/index.js";
import { writeDeliveryBlueprintFixture } from "../engine/lifecycle-blueprint.test-support.js";
import { SqlitePersistence } from "../persistence/index.js";
import { ensureWorktree } from "./worktree-creator.js";
import {
  cleanupMergedChange,
  createMechanicalNodeEffects,
  ensureReviewSnapshot,
  mechanicalChangeContextKey,
  mergeReviewSnapshot,
  type CommandRunner,
  type MechanicalChangeContext,
  type MechanicalNodeEffectOptions,
} from "./mechanical-node-effects.js";

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];

const runCommand: CommandRunner = (cwd, executable, arguments_, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      arguments_,
      { cwd, encoding: "utf8" },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });

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
  const worktreePath = join(worktreesRoot, "task-change", "sample-repository");
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
  beforeReviewSnapshot?: (fixture: {
    change: MechanicalChangeContext;
    sourcePath: string;
    worktreePath: string;
  }) => Promise<void>,
) => {
  const fixture = await makeChange();
  fixture.change.taskId = taskId;
  await writeDeliveryBlueprintFixture(fixture.sourcePath);
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
  await beforeReviewSnapshot?.(fixture);
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
    expect(await git(fixture.sourcePath, "rev-parse", "main")).toBe(
      firstSnapshot.sourceHead + "\n",
    );
    expect(await git(fixture.sourcePath, "rev-list", "--merges", "main")).toBe(
      "",
    );
    expect(
      await git(
        fixture.sourcePath,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ),
    ).toBe("");

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

  it("routes recorded-base drift to remediation without merging", async () => {
    const fixture = await prepareCommittedChange();
    const intermediateHead = (
      await git(fixture.sourcePath, "rev-parse", "task/change")
    ).trim();
    await writeFile(join(fixture.worktreePath, "notes.txt"), "checked\n");
    await git(fixture.worktreePath, "add", "notes.txt");
    await git(fixture.worktreePath, "commit", "--quiet", "-m", "add note");
    const snapshot = await ensureReviewSnapshot(fixture.change);
    await git(
      fixture.sourcePath,
      "update-ref",
      "refs/heads/main",
      intermediateHead,
      snapshot.baseHead,
    );

    await expect(
      mergeReviewSnapshot(fixture.change, snapshot.snapshotId),
    ).resolves.toEqual({
      alreadyMerged: false,
      dispositions: { merged: false, remediate: true },
      merged: false,
      snapshotId: snapshot.snapshotId,
    });
    expect(await git(fixture.sourcePath, "rev-parse", "main")).toBe(
      intermediateHead + "\n",
    );
  });

  it("routes base movement at the atomic merge boundary to remediation", async () => {
    const fixture = await prepareCommittedChange();
    const intermediateHead = (
      await git(fixture.sourcePath, "rev-parse", "task/change")
    ).trim();
    await writeFile(join(fixture.worktreePath, "notes.txt"), "checked\n");
    await git(fixture.worktreePath, "add", "notes.txt");
    await git(fixture.worktreePath, "commit", "--quiet", "-m", "add note");
    const snapshot = await ensureReviewSnapshot(fixture.change);
    let moved = false;
    const command: CommandRunner = async (
      cwd,
      executable,
      arguments_,
      input,
    ) => {
      if (
        !moved &&
        executable === "git" &&
        arguments_[0] === "update-ref" &&
        arguments_[1] === "--stdin" &&
        input?.includes("update refs/heads/main")
      ) {
        moved = true;
        await git(
          fixture.sourcePath,
          "update-ref",
          "refs/heads/main",
          intermediateHead,
          snapshot.baseHead,
        );
      }
      return runCommand(cwd, executable, arguments_, input);
    };

    await expect(
      mergeReviewSnapshot(fixture.change, snapshot.snapshotId, command),
    ).resolves.toMatchObject({
      dispositions: { merged: false, remediate: true },
      merged: false,
    });
    expect(await git(fixture.sourcePath, "rev-parse", "main")).toBe(
      intermediateHead + "\n",
    );
  });

  it("resumes an interrupted atomic merge before approving the snapshot", async () => {
    const fixture = await prepareCommittedChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    let interrupted = false;
    const command: CommandRunner = async (
      cwd,
      executable,
      arguments_,
      input,
    ) => {
      if (
        !interrupted &&
        executable === "git" &&
        arguments_[0] === "reset" &&
        arguments_[1] === "--hard"
      ) {
        interrupted = true;
        throw new Error("simulated merge interruption");
      }
      return runCommand(cwd, executable, arguments_, input);
    };

    await expect(
      mergeReviewSnapshot(fixture.change, snapshot.snapshotId, command),
    ).rejects.toThrow(/simulated merge interruption/);
    expect(await git(fixture.sourcePath, "rev-parse", "main")).toBe(
      snapshot.sourceHead + "\n",
    );

    await expect(
      mergeReviewSnapshot(fixture.change, snapshot.snapshotId),
    ).resolves.toMatchObject({ merged: true });
    expect(
      await git(
        fixture.sourcePath,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ),
    ).toBe("");
  });

  it("holds the exact merged base while approving the snapshot", async () => {
    const fixture = await prepareCommittedChange();
    const intermediateHead = (
      await git(fixture.sourcePath, "rev-parse", "task/change")
    ).trim();
    await writeFile(join(fixture.worktreePath, "notes.txt"), "checked\n");
    await git(fixture.worktreePath, "add", "notes.txt");
    await git(fixture.worktreePath, "commit", "--quiet", "-m", "add note");
    const snapshot = await ensureReviewSnapshot(fixture.change);
    let attempted = false;
    const command: CommandRunner = async (
      cwd,
      executable,
      arguments_,
      input,
    ) => {
      if (!attempted && executable === "gitpr" && arguments_[0] === "merge") {
        attempted = true;
        await git(
          fixture.sourcePath,
          "update-ref",
          "refs/heads/main",
          intermediateHead,
          snapshot.sourceHead,
        );
      }
      return runCommand(cwd, executable, arguments_, input);
    };

    await expect(
      mergeReviewSnapshot(fixture.change, snapshot.snapshotId, command),
    ).rejects.toThrow();
    expect(attempted).toBe(true);
    expect(await git(fixture.sourcePath, "rev-parse", "main")).toBe(
      snapshot.sourceHead + "\n",
    );

    await expect(
      mergeReviewSnapshot(fixture.change, snapshot.snapshotId),
    ).resolves.toMatchObject({ merged: true });
  });

  it("approves the exact merge when the base branch is not checked out", async () => {
    const fixture = await prepareCommittedChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    await git(fixture.sourcePath, "switch", "--detach");

    await expect(
      mergeReviewSnapshot(fixture.change, snapshot.snapshotId),
    ).resolves.toMatchObject({ merged: true });
    await expect(
      mergeReviewSnapshot(fixture.change, snapshot.snapshotId),
    ).resolves.toMatchObject({ alreadyMerged: true });
    expect(await git(fixture.sourcePath, "rev-parse", "main")).toBe(
      snapshot.sourceHead + "\n",
    );
    expect(
      await git(
        fixture.sourcePath,
        "for-each-ref",
        "--format=%(refname)",
        "refs/gitpr/index/approved",
      ),
    ).toContain(snapshot.snapshotId);
    expect(
      await git(fixture.sourcePath, "worktree", "list", "--porcelain"),
    ).not.toContain(`${fixture.change.worktreeName}.merge-base`);
  });

  it("removes an approval worktree on replay after approval was recorded", async () => {
    const fixture = await prepareCommittedChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    const approvalWorktreePath = join(
      fixture.change.worktreesRoot!,
      `${fixture.change.worktreeName}.merge-base`,
      fixture.change.repositoryName,
    );
    await git(fixture.sourcePath, "switch", "--detach");
    let interrupted = false;
    const command: CommandRunner = async (
      cwd,
      executable,
      arguments_,
      input,
    ) => {
      if (
        !interrupted &&
        executable === "git" &&
        arguments_[0] === "worktree" &&
        arguments_[1] === "remove" &&
        arguments_.at(-1) === approvalWorktreePath
      ) {
        interrupted = true;
        throw new Error("simulated approval cleanup interruption");
      }
      return runCommand(cwd, executable, arguments_, input);
    };

    await expect(
      mergeReviewSnapshot(fixture.change, snapshot.snapshotId, command),
    ).rejects.toThrow(/approval cleanup interruption/);
    await expect(lstat(approvalWorktreePath)).resolves.toBeDefined();

    await expect(
      mergeReviewSnapshot(fixture.change, snapshot.snapshotId),
    ).resolves.toMatchObject({ alreadyMerged: true });
    await expect(lstat(approvalWorktreePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails a conflicting merge and preserves both branch heads", async () => {
    const fixture = await prepareCommittedChange();
    await writeFile(join(fixture.sourcePath, "inventory.txt"), "replacement\n");
    await git(fixture.sourcePath, "add", "inventory.txt");
    await git(fixture.sourcePath, "commit", "--quiet", "-m", "replace item");
    const snapshot = await ensureReviewSnapshot(fixture.change);
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

  it("refuses a reviewed history that contains a merge commit", async () => {
    const fixture = await prepareCommittedChange();
    const sourceHead = (
      await git(fixture.sourcePath, "rev-parse", "task/change")
    ).trim();
    const baseHead = (
      await git(fixture.sourcePath, "rev-parse", "main")
    ).trim();
    const tree = (
      await git(fixture.sourcePath, "rev-parse", "task/change^{tree}")
    ).trim();
    const mergeHead = (
      await git(
        fixture.sourcePath,
        "commit-tree",
        tree,
        "-p",
        sourceHead,
        "-p",
        baseHead,
        "-m",
        "combine histories",
      )
    ).trim();
    await git(
      fixture.sourcePath,
      "update-ref",
      "refs/heads/task/change",
      mergeHead,
      sourceHead,
    );
    const snapshot = await ensureReviewSnapshot(fixture.change);

    await expect(
      mergeReviewSnapshot(fixture.change, snapshot.snapshotId),
    ).rejects.toThrow(/merge commit/);
    expect(await git(fixture.sourcePath, "rev-parse", "main")).toBe(
      baseHead + "\n",
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

  it("restores the worktree when the merged branch moves during cleanup", async () => {
    const fixture = await prepareCommittedChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    await mergeReviewSnapshot(fixture.change, snapshot.snapshotId);
    let movedHead: string | undefined;
    let moved = false;
    const command: CommandRunner = async (
      cwd,
      executable,
      arguments_,
      input,
    ) => {
      if (
        !moved &&
        executable === "git" &&
        arguments_[0] === "worktree" &&
        arguments_[1] === "remove"
      ) {
        moved = true;
        const tree = (
          await git(fixture.sourcePath, "rev-parse", "task/change^{tree}")
        ).trim();
        movedHead = (
          await git(
            fixture.sourcePath,
            "commit-tree",
            tree,
            "-p",
            snapshot.sourceHead,
            "-m",
            "move branch",
          )
        ).trim();
        await git(
          fixture.sourcePath,
          "update-ref",
          "refs/heads/task/change",
          movedHead,
          snapshot.sourceHead,
        );
      }
      return runCommand(cwd, executable, arguments_, input);
    };

    await expect(
      cleanupMergedChange(fixture.change, snapshot.snapshotId, command),
    ).rejects.toThrow();
    expect(movedHead).toBeDefined();
    await expect(lstat(fixture.worktreePath)).resolves.toBeDefined();
    expect(
      await git(fixture.worktreePath, "symbolic-ref", "--short", "HEAD"),
    ).toBe("task/change\n");
    expect(await git(fixture.sourcePath, "rev-parse", "task/change")).toBe(
      movedHead + "\n",
    );
  });

  it("restores resources when the base rewinds during cleanup", async () => {
    const fixture = await prepareCommittedChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    await mergeReviewSnapshot(fixture.change, snapshot.snapshotId);
    let rewound = false;
    const command: CommandRunner = async (
      cwd,
      executable,
      arguments_,
      input,
    ) => {
      if (
        !rewound &&
        executable === "git" &&
        arguments_[0] === "worktree" &&
        arguments_[1] === "remove"
      ) {
        rewound = true;
        await git(
          fixture.sourcePath,
          "update-ref",
          "refs/heads/main",
          snapshot.baseHead,
          snapshot.sourceHead,
        );
      }
      return runCommand(cwd, executable, arguments_, input);
    };

    await expect(
      cleanupMergedChange(fixture.change, snapshot.snapshotId, command),
    ).rejects.toThrow();
    await expect(lstat(fixture.worktreePath)).resolves.toBeDefined();
    expect(await git(fixture.sourcePath, "rev-parse", "task/change")).toBe(
      snapshot.sourceHead + "\n",
    );
    expect(await git(fixture.sourcePath, "rev-parse", "main")).toBe(
      snapshot.baseHead + "\n",
    );
  });

  it("fails cleanup closed when branch resolution has a transient failure", async () => {
    const fixture = await prepareCommittedChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    await mergeReviewSnapshot(fixture.change, snapshot.snapshotId);
    let failed = false;
    const command: CommandRunner = async (
      cwd,
      executable,
      arguments_,
      input,
    ) => {
      if (
        !failed &&
        executable === "git" &&
        arguments_.some((value) =>
          value.includes("refs/heads/task/change^{commit}"),
        )
      ) {
        failed = true;
        throw new Error("transient branch lookup failure");
      }
      return runCommand(cwd, executable, arguments_, input);
    };

    await expect(
      cleanupMergedChange(fixture.change, snapshot.snapshotId, command),
    ).rejects.toThrow(/transient branch lookup failure/);
    await expect(lstat(fixture.worktreePath)).resolves.toBeDefined();
    expect(await git(fixture.sourcePath, "rev-parse", "task/change")).toBe(
      snapshot.sourceHead + "\n",
    );
  });

  it("restores an absent worktree after interrupted cleanup and branch movement", async () => {
    const fixture = await prepareCommittedChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    await mergeReviewSnapshot(fixture.change, snapshot.snapshotId);
    let interrupted = false;
    let movedHead: string | undefined;
    const command: CommandRunner = async (
      cwd,
      executable,
      arguments_,
      input,
    ) => {
      if (
        !interrupted &&
        executable === "git" &&
        arguments_[0] === "worktree" &&
        arguments_[1] === "remove"
      ) {
        interrupted = true;
        await runCommand(cwd, executable, arguments_, input);
        const tree = (
          await git(fixture.sourcePath, "rev-parse", "task/change^{tree}")
        ).trim();
        movedHead = (
          await git(
            fixture.sourcePath,
            "commit-tree",
            tree,
            "-p",
            snapshot.sourceHead,
            "-m",
            "move branch",
          )
        ).trim();
        await git(
          fixture.sourcePath,
          "update-ref",
          "refs/heads/task/change",
          movedHead,
          snapshot.sourceHead,
        );
        throw new Error("simulated interruption");
      }
      return runCommand(cwd, executable, arguments_, input);
    };

    await expect(
      cleanupMergedChange(fixture.change, snapshot.snapshotId, command),
    ).rejects.toThrow(/simulated interruption/);
    await expect(lstat(fixture.worktreePath)).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(
      cleanupMergedChange(fixture.change, snapshot.snapshotId),
    ).rejects.toThrow(/moved/);
    expect(movedHead).toBeDefined();
    await expect(lstat(fixture.worktreePath)).resolves.toBeDefined();
    expect(await git(fixture.sourcePath, "rev-parse", "task/change")).toBe(
      movedHead + "\n",
    );
  });

  it("preserves merged resources when the base no longer contains the snapshot", async () => {
    const fixture = await prepareCommittedChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    await mergeReviewSnapshot(fixture.change, snapshot.snapshotId);
    await git(
      fixture.sourcePath,
      "update-ref",
      "refs/heads/main",
      snapshot.baseHead,
      snapshot.sourceHead,
    );

    await expect(
      mergeReviewSnapshot(fixture.change, snapshot.snapshotId),
    ).rejects.toThrow();
    await expect(
      cleanupMergedChange(fixture.change, snapshot.snapshotId),
    ).rejects.toThrow();
    await expect(lstat(fixture.worktreePath)).resolves.toBeDefined();
    expect(await git(fixture.sourcePath, "rev-parse", "task/change")).toBe(
      snapshot.sourceHead + "\n",
    );
  });

  it("refuses cleanup when an approved snapshot is absent from the base", async () => {
    const fixture = await prepareCommittedChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    await mergeReviewSnapshot(fixture.change, snapshot.snapshotId);
    await git(
      fixture.sourcePath,
      "update-ref",
      "refs/heads/main",
      snapshot.baseHead,
      snapshot.sourceHead,
    );

    await expect(
      cleanupMergedChange(fixture.change, snapshot.snapshotId),
    ).rejects.toThrow();
    await expect(lstat(fixture.worktreePath)).resolves.toBeDefined();
  });

  it("refuses cleanup for an open snapshot even when its head is integrated", async () => {
    const fixture = await prepareCommittedChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    await git(
      fixture.sourcePath,
      "update-ref",
      "refs/heads/main",
      snapshot.sourceHead,
      snapshot.baseHead,
    );

    await expect(
      cleanupMergedChange(fixture.change, snapshot.snapshotId),
    ).rejects.toThrow(/not approved/);
    await expect(lstat(fixture.worktreePath)).resolves.toBeDefined();
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

  it("rejects a wrong-branch owned path without creating a snapshot", async () => {
    const fixture = await makeChange();
    await git(fixture.sourcePath, "branch", "task/change", "main");
    await mkdir(join(fixture.change.worktreesRoot!, "task-change"), {
      recursive: true,
    });
    await git(
      fixture.sourcePath,
      "worktree",
      "add",
      "--quiet",
      "-b",
      "task/other",
      fixture.worktreePath,
      "main",
    );

    await expect(ensureReviewSnapshot(fixture.change)).rejects.toThrow(
      /uses branch/,
    );
    expect(
      await git(
        fixture.sourcePath,
        "for-each-ref",
        "--format=%(refname)",
        "refs/gitpr/pr",
      ),
    ).toBe("");
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
    const fixture = await makeLifecycle(
      {},
      undefined,
      async ({ sourcePath }) => {
        await writeFile(join(sourcePath, "inventory.txt"), "replacement\n");
        await git(sourcePath, "add", "inventory.txt");
        await git(sourcePath, "commit", "--quiet", "-m", "replace item");
      },
    );

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
          mirrorTaskStatus: async (taskId, status) => {
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

  it("continues mechanical delivery without a task ID while skipping board mirroring", async () => {
    const mirrored: Array<{ status: string; taskId: number }> = [];
    const fixture = await makeLifecycle({
      board: {
        mirrorTaskStatus: async (taskId, status) => {
          mirrored.push({ status, taskId });
        },
      },
      statuses: {
        completed: "done",
        inProgress: "in-progress",
        merged: "retrospective",
        review: "review",
      },
    });

    const retrospective = await fixture.engine.resume({
      disposition: "approve",
      instanceId: "sample-lifecycle",
      operationId: "review-approved",
    });
    const completed = await fixture.engine.resume({
      disposition: "complete",
      instanceId: "sample-lifecycle",
      operationId: "retrospective-complete",
    });

    expect(retrospective.awaitingNodeIds).toEqual(["retrospective"]);
    expect(completed.status).toBe("completed");
    await expect(lstat(fixture.worktreePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(mirrored).toEqual([]);
    fixture.persistence.close();
  });
});
