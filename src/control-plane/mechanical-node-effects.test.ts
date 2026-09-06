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

import {
  LifecycleEngine,
  UnexpectedLandingError,
  type LifecycleEffectInput,
} from "../engine/index.js";
import { writeDeliveryBlueprintFixture } from "../engine/lifecycle-blueprint.test-support.js";
import { SqlitePersistence } from "../persistence/index.js";
import { ensureWorktree } from "./worktree-creator.js";
import {
  cleanupMergedChange,
  createMechanicalNodeEffects,
  ensureReviewSnapshot,
  resolveMechanicalBoardStatuses,
  mechanicalChangeContextKey,
  mergeReviewSnapshot,
  type CommandRunner,
  type MechanicalChangeContext,
  type MechanicalNodeEffectOptions,
} from "./mechanical-node-effects.js";
import { readReviewSnapshot } from "./review-snapshot.js";

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

const writeGitprMetaRef = async (
  repositoryRoot: string,
  snapshotId: string,
  content: string,
  state?: "open" | "merged" | "closed",
): Promise<void> => {
  const blob = (
    await runCommand(
      repositoryRoot,
      "git",
      ["hash-object", "-w", "--stdin"],
      content,
    )
  ).trim();
  const tree = (
    await runCommand(
      repositoryRoot,
      "git",
      ["mktree"],
      `100644 blob ${blob}\tpr.yaml\n`,
    )
  ).trim();
  const commit = (
    await git(repositoryRoot, "commit-tree", tree, "-m", "legacy review")
  ).trim();
  await git(
    repositoryRoot,
    "update-ref",
    `refs/gitpr/pr/${snapshotId}/meta`,
    commit,
  );
  if (state !== undefined) {
    await git(
      repositoryRoot,
      "update-ref",
      `refs/gitpr/index/${state}/${snapshotId}`,
      commit,
    );
  }
};

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
  it("requires every declared board status before mirroring delivery", () => {
    expect(() =>
      resolveMechanicalBoardStatuses(["done", "in-progress", "review"]),
    ).toThrow(
      "Board configuration is missing required mechanical status 'retrospective'",
    );
  });

  it("re-runs worktree, snapshot, merge, and cleanup effects without duplicates", async () => {
    const fixture = await prepareCommittedChange();
    expect(fixture.prepared.map(({ created }) => created)).toEqual([
      true,
      false,
    ]);

    const firstSnapshot = await ensureReviewSnapshot(fixture.change);
    const secondSnapshot = await ensureReviewSnapshot(fixture.change);
    expect(secondSnapshot).toEqual(firstSnapshot);
    expect(firstSnapshot).toMatchObject({
      latestEvent: null,
      schema: 2,
      state: "open",
    });
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

    const firstMerge = await mergeReviewSnapshot(fixture.change, firstSnapshot);
    const secondMerge = await mergeReviewSnapshot(
      fixture.change,
      firstSnapshot,
    );
    expect(firstMerge).toMatchObject({ merged: true, alreadyMerged: false });
    expect(secondMerge).toMatchObject({ merged: false, alreadyMerged: true });
    expect(
      await readReviewSnapshot(
        fixture.sourcePath,
        firstSnapshot.snapshotId,
        runCommand,
      ),
    ).toMatchObject({
      latestEvent: {
        baseHead: firstSnapshot.baseHead,
        sourceHead: firstSnapshot.sourceHead,
        verdict: "accepted",
      },
      schema: 2,
      state: "merged",
    });
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

  it("terminalizes and cleans an exact accepted no-op review without invoking merge", async () => {
    const fixture = await makeChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    const gitprCommands: string[][] = [];
    const command: CommandRunner = async (
      cwd,
      executable,
      arguments_,
      input,
    ) => {
      if (executable === "gitpr") gitprCommands.push(arguments_);
      return runCommand(cwd, executable, arguments_, input);
    };

    expect(snapshot.sourceHead).toBe(snapshot.baseHead);
    await expect(
      mergeReviewSnapshot(fixture.change, snapshot, command),
    ).resolves.toEqual({
      alreadyMerged: true,
      dispositions: { merged: true, remediate: false },
      merged: false,
      snapshotId: snapshot.snapshotId,
    });
    expect(gitprCommands).toContainEqual([
      "close",
      snapshot.snapshotId,
      "--reason",
      "integrated",
      "--destination",
      "main",
      "--commit",
      snapshot.sourceHead,
    ]);
    expect(gitprCommands.some(([subcommand]) => subcommand === "merge")).toBe(
      false,
    );
    await expect(
      readReviewSnapshot(fixture.sourcePath, snapshot.snapshotId, runCommand),
    ).resolves.toMatchObject({
      closure: {
        destinationBranch: "main",
        reason: "integrated",
        resultingCommitShas: [snapshot.sourceHead],
      },
      latestEvent: {
        baseHead: snapshot.baseHead,
        sourceHead: snapshot.sourceHead,
        verdict: "accepted",
      },
      state: "closed",
    });
    await expect(
      mergeReviewSnapshot(fixture.change, snapshot, command),
    ).resolves.toEqual({
      alreadyMerged: true,
      dispositions: { merged: true, remediate: false },
      merged: false,
      snapshotId: snapshot.snapshotId,
    });
    expect(
      gitprCommands.filter(([subcommand]) => subcommand === "close"),
    ).toHaveLength(1);

    await expect(
      cleanupMergedChange(fixture.change, snapshot.snapshotId),
    ).resolves.toEqual({
      branchDeleted: true,
      snapshotId: snapshot.snapshotId,
      worktreeRemoved: true,
    });
    await expect(
      cleanupMergedChange(fixture.change, snapshot.snapshotId),
    ).resolves.toEqual({
      branchDeleted: false,
      snapshotId: snapshot.snapshotId,
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

  it("refuses a closed no-op review without exact integrated evidence", async () => {
    const fixture = await makeChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    await runCommand(fixture.sourcePath, "gitpr", [
      "approve",
      snapshot.snapshotId,
      "--basis",
      `${snapshot.sourceHead}:${snapshot.baseHead}`,
    ]);
    await runCommand(fixture.sourcePath, "gitpr", [
      "close",
      snapshot.snapshotId,
      "--reason",
      "abandoned",
    ]);

    await expect(mergeReviewSnapshot(fixture.change, snapshot)).rejects.toThrow(
      /does not preserve the exact accepted no-op integration/,
    );
    await expect(
      cleanupMergedChange(fixture.change, snapshot.snapshotId),
    ).rejects.toThrow(/not integrated by an exact approval/);
    await expect(lstat(fixture.worktreePath)).resolves.toBeDefined();
    expect(await git(fixture.sourcePath, "rev-parse", "task/change")).toBe(
      snapshot.sourceHead + "\n",
    );
  });

  it.each(["destination", "commit", "extra-commit"] as const)(
    "refuses a closed no-op review with mismatched integrated %s evidence",
    async (mismatch) => {
      const fixture = await makeChange();
      const snapshot = await ensureReviewSnapshot(fixture.change);
      await runCommand(fixture.sourcePath, "gitpr", [
        "approve",
        snapshot.snapshotId,
        "--basis",
        `${snapshot.sourceHead}:${snapshot.baseHead}`,
      ]);
      await runCommand(fixture.sourcePath, "gitpr", [
        "close",
        snapshot.snapshotId,
        "--reason",
        "integrated",
        "--destination",
        mismatch === "destination" ? "other" : "main",
        "--commit",
        mismatch === "commit" ? "a".repeat(40) : snapshot.sourceHead,
        ...(mismatch === "extra-commit" ? ["--commit", "a".repeat(40)] : []),
      ]);

      await expect(
        mergeReviewSnapshot(fixture.change, snapshot),
      ).rejects.toThrow(
        /does not preserve the exact accepted no-op integration/,
      );
      await expect(
        cleanupMergedChange(fixture.change, snapshot.snapshotId),
      ).rejects.toThrow(/not integrated by an exact approval/);
      await expect(lstat(fixture.worktreePath)).resolves.toBeDefined();
    },
  );

  it("refuses integrated closure when the accepted source contains a change", async () => {
    const fixture = await prepareCommittedChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    await runCommand(fixture.sourcePath, "gitpr", [
      "approve",
      snapshot.snapshotId,
      "--basis",
      `${snapshot.sourceHead}:${snapshot.baseHead}`,
    ]);
    await runCommand(fixture.sourcePath, "gitpr", [
      "close",
      snapshot.snapshotId,
      "--reason",
      "integrated",
      "--destination",
      "main",
      "--commit",
      snapshot.sourceHead,
    ]);

    await expect(mergeReviewSnapshot(fixture.change, snapshot)).rejects.toThrow(
      /does not preserve the exact accepted no-op integration/,
    );
    await expect(
      cleanupMergedChange(fixture.change, snapshot.snapshotId),
    ).rejects.toThrow(/not integrated by an exact approval/);
    expect(await git(fixture.sourcePath, "rev-parse", "main")).toBe(
      snapshot.baseHead + "\n",
    );
  });

  it("refuses integrated closure without an accepted event", async () => {
    const fixture = await makeChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    await runCommand(fixture.sourcePath, "gitpr", [
      "reject",
      snapshot.snapshotId,
      "--basis",
      `${snapshot.sourceHead}:${snapshot.baseHead}`,
    ]);
    await runCommand(fixture.sourcePath, "gitpr", [
      "close",
      snapshot.snapshotId,
      "--reason",
      "integrated",
      "--destination",
      "main",
      "--commit",
      snapshot.sourceHead,
    ]);

    await expect(mergeReviewSnapshot(fixture.change, snapshot)).rejects.toThrow(
      /does not preserve the exact accepted no-op integration/,
    );
    await expect(
      cleanupMergedChange(fixture.change, snapshot.snapshotId),
    ).rejects.toThrow(/not integrated by an exact approval/);
  });

  it("refuses legacy status and non-schema-2 review states", async () => {
    const record =
      (body: string): CommandRunner =>
      async () =>
        body;
    const common = [
      "id: SAMPLE1",
      "source_branch: task/sample",
      "base_branch: main",
    ].join("\n");

    await expect(
      readReviewSnapshot(
        "/tmp/sample-repository",
        "SAMPLE1",
        record([common, "status: open"].join("\n")),
      ),
    ).rejects.toThrow(/unsupported schema/);
    await expect(
      readReviewSnapshot(
        "/tmp/sample-repository",
        "SAMPLE1",
        record(["schema: 2", common, "state: approved"].join("\n")),
      ),
    ).rejects.toThrow(/invalid state.*approved/);
  });

  it("ignores an unrelated oversized legacy record when finding the open review", async () => {
    const fixture = await prepareCommittedChange();
    await writeGitprMetaRef(
      fixture.sourcePath,
      "LEGACY1",
      [
        "id: LEGACY1",
        "status: open",
        "source_branch: task/other",
        "base_branch: main",
        "file_diffs:",
        "  - patch: |",
        `      ${"x".repeat(11 * 1024 * 1024)}`,
      ].join("\n"),
      "open",
    );

    const snapshot = await ensureReviewSnapshot(fixture.change);
    const replayed = await ensureReviewSnapshot(fixture.change);

    expect(snapshot).toMatchObject({ schema: 2, state: "open" });
    expect(snapshot.snapshotId).not.toBe("LEGACY1");
    expect(replayed.snapshotId).toBe(snapshot.snapshotId);
  });

  it("fails closed when the matching indexed record is corrupt", async () => {
    const fixture = await prepareCommittedChange();
    await writeGitprMetaRef(
      fixture.sourcePath,
      "BROKEN1",
      [
        "schema: 2",
        "id: BROKEN1",
        "source_branch: task/change",
        "base_branch: main",
        "state: open",
        "events: [",
      ].join("\n"),
      "open",
    );

    await expect(ensureReviewSnapshot(fixture.change)).rejects.toThrow(
      /invalid YAML/,
    );
    expect(
      await git(
        fixture.sourcePath,
        "for-each-ref",
        "--format=%(refname)",
        "refs/gitpr/pr",
      ),
    ).toBe("refs/gitpr/pr/BROKEN1/meta\n");
  });

  it("preserves a rejected verdict for the exact review basis", async () => {
    const fixture = await prepareCommittedChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    await runCommand(fixture.sourcePath, "gitpr", [
      "reject",
      snapshot.snapshotId,
      "--basis",
      `${snapshot.sourceHead}:${snapshot.baseHead}`,
    ]);

    await expect(mergeReviewSnapshot(fixture.change, snapshot)).rejects.toThrow(
      /rejected.*review basis/,
    );
    expect(await git(fixture.sourcePath, "rev-parse", "main")).toBe(
      snapshot.baseHead + "\n",
    );
    await expect(
      readReviewSnapshot(fixture.sourcePath, snapshot.snapshotId, runCommand),
    ).resolves.toMatchObject({
      latestEvent: {
        baseHead: snapshot.baseHead,
        sourceHead: snapshot.sourceHead,
        verdict: "rejected",
      },
      state: "open",
    });
  });

  it.each(["sourceHead", "baseHead"] as const)(
    "rejects an invalid persisted review %s",
    async (field) => {
      const fixture = await makeChange();
      const effects = createMechanicalNodeEffects({
        command: async () => {
          throw new Error("mechanical command must not run");
        },
      });
      const snapshot = {
        baseBranch: "main",
        baseHead: "b".repeat(40),
        latestEvent: null,
        schema: 2,
        snapshotId: "SAMPLE1",
        sourceBranch: "task/change",
        sourceHead: "a".repeat(40),
        state: "open",
        [field]: "not-an-object-id",
      };
      const input = {
        context: {
          get: async (key: string) =>
            key === mechanicalChangeContextKey ? fixture.change : snapshot,
        },
        idempotencyKey: "sample-effect",
        input: null,
        params: {},
      } as unknown as LifecycleEffectInput;

      await expect(effects.merge(input)).rejects.toThrow(
        `Review snapshot output has invalid ${field}`,
      );
    },
  );

  it("repeatedly routes an unchanged already-behind review source to remediation", async () => {
    const fixture = await prepareCommittedChange();
    await writeFile(join(fixture.sourcePath, "catalog.txt"), "published\n");
    await git(fixture.sourcePath, "add", "catalog.txt");
    await git(fixture.sourcePath, "commit", "--quiet", "-m", "publish catalog");
    const snapshot = await ensureReviewSnapshot(fixture.change);
    const expected = {
      alreadyMerged: false,
      dispositions: { merged: false, remediate: true },
      merged: false,
      remediationCause: {
        currentSourceHead: snapshot.sourceHead,
        currentTargetHead: snapshot.baseHead,
        kind: "review-source-behind",
        reviewedBaseHead: snapshot.baseHead,
        reviewedSourceHead: snapshot.sourceHead,
        snapshotId: snapshot.snapshotId,
        sourceBranch: "task/change",
        targetBranch: "main",
      },
      snapshotId: snapshot.snapshotId,
    };

    await expect(
      mergeReviewSnapshot(fixture.change, snapshot),
    ).resolves.toEqual(expected);
    await expect(
      mergeReviewSnapshot(fixture.change, snapshot),
    ).resolves.toEqual(expected);
    await expect(
      readReviewSnapshot(
        fixture.change.repositoryRoot,
        snapshot.snapshotId,
        runCommand,
      ),
    ).resolves.toMatchObject({ latestEvent: null, state: "open" });
    expect(await git(fixture.sourcePath, "rev-parse", "main")).toBe(
      snapshot.baseHead + "\n",
    );

    await git(fixture.worktreePath, "rebase", "main");
    const remediatedSnapshot = await ensureReviewSnapshot(fixture.change);
    expect(remediatedSnapshot).toMatchObject({
      baseHead: snapshot.baseHead,
      snapshotId: snapshot.snapshotId,
    });
    expect(remediatedSnapshot.sourceHead).not.toBe(snapshot.sourceHead);
    await expect(
      mergeReviewSnapshot(fixture.change, remediatedSnapshot),
    ).resolves.toMatchObject({
      dispositions: { merged: true, remediate: false },
      merged: true,
    });
  });

  it("keeps unrelated review histories on the visible failure path", async () => {
    const fixture = await prepareCommittedChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    const command: CommandRunner = async (
      cwd,
      executable,
      arguments_,
      input,
    ) => {
      if (executable === "git" && arguments_[0] === "merge-base") {
        throw Object.assign(new Error("no common history"), { code: 1 });
      }
      return runCommand(cwd, executable, arguments_, input);
    };

    await expect(
      mergeReviewSnapshot(fixture.change, snapshot, command),
    ).rejects.toThrow("Reviewed source and target have unrelated histories");
  });

  it("reports basis drift when the target moves during source-behind classification", async () => {
    const fixture = await prepareCommittedChange();
    await writeFile(join(fixture.sourcePath, "catalog.txt"), "published\n");
    await git(fixture.sourcePath, "add", "catalog.txt");
    await git(fixture.sourcePath, "commit", "--quiet", "-m", "publish catalog");
    const snapshot = await ensureReviewSnapshot(fixture.change);
    const targetTree = (
      await git(fixture.sourcePath, "rev-parse", `${snapshot.baseHead}^{tree}`)
    ).trim();
    const nextTargetHead = (
      await git(
        fixture.sourcePath,
        "commit-tree",
        targetTree,
        "-p",
        snapshot.baseHead,
        "-m",
        "advance catalog",
      )
    ).trim();
    let moved = false;
    const command: CommandRunner = async (
      cwd,
      executable,
      arguments_,
      input,
    ) => {
      const output = await runCommand(cwd, executable, arguments_, input);
      if (
        !moved &&
        executable === "git" &&
        arguments_[0] === "merge-base" &&
        arguments_[1] !== "--is-ancestor"
      ) {
        moved = true;
        await git(
          fixture.sourcePath,
          "update-ref",
          "refs/heads/main",
          nextTargetHead,
          snapshot.baseHead,
        );
      }
      return output;
    };

    await expect(
      mergeReviewSnapshot(fixture.change, snapshot, command),
    ).resolves.toMatchObject({
      dispositions: { merged: false, remediate: true },
      remediationCause: {
        currentSourceHead: snapshot.sourceHead,
        currentTargetHead: nextTargetHead,
        kind: "review-basis-drift",
        reviewedBaseHead: snapshot.baseHead,
        reviewedSourceHead: snapshot.sourceHead,
      },
    });
  });

  it("does not convert an ancestry command failure into remediation", async () => {
    const fixture = await prepareCommittedChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    const command: CommandRunner = async (
      cwd,
      executable,
      arguments_,
      input,
    ) => {
      if (
        executable === "git" &&
        arguments_[0] === "merge-base" &&
        arguments_[1] === "--is-ancestor"
      ) {
        throw Object.assign(new Error("repository unavailable"), { code: 128 });
      }
      return runCommand(cwd, executable, arguments_, input);
    };

    await expect(
      mergeReviewSnapshot(fixture.change, snapshot, command),
    ).rejects.toThrow("repository unavailable");
  });

  it("routes source-head drift to remediation without merging", async () => {
    const fixture = await prepareCommittedChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    const baseBefore = await git(fixture.sourcePath, "rev-parse", "main");
    await writeFile(join(fixture.worktreePath, "notes.txt"), "checked\n");
    await git(fixture.worktreePath, "add", "notes.txt");
    await git(fixture.worktreePath, "commit", "--quiet", "-m", "add note");
    const currentSourceHead = (
      await git(fixture.sourcePath, "rev-parse", "task/change")
    ).trim();

    await expect(
      mergeReviewSnapshot(fixture.change, snapshot),
    ).resolves.toEqual({
      alreadyMerged: false,
      dispositions: { merged: false, remediate: true },
      merged: false,
      remediationCause: {
        currentSourceHead,
        currentTargetHead: baseBefore.trim(),
        kind: "review-basis-drift",
        reviewedBaseHead: snapshot.baseHead,
        reviewedSourceHead: snapshot.sourceHead,
        snapshotId: snapshot.snapshotId,
        sourceBranch: "task/change",
        targetBranch: "main",
      },
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
      mergeReviewSnapshot(fixture.change, snapshot),
    ).resolves.toEqual({
      alreadyMerged: false,
      dispositions: { merged: false, remediate: true },
      merged: false,
      remediationCause: {
        currentSourceHead: snapshot.sourceHead,
        currentTargetHead: intermediateHead,
        kind: "review-basis-drift",
        reviewedBaseHead: snapshot.baseHead,
        reviewedSourceHead: snapshot.sourceHead,
        snapshotId: snapshot.snapshotId,
        sourceBranch: "task/change",
        targetBranch: "main",
      },
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
      if (!moved && executable === "gitpr" && arguments_[0] === "merge") {
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
      mergeReviewSnapshot(fixture.change, snapshot, command),
    ).resolves.toMatchObject({
      dispositions: { merged: false, remediate: true },
      merged: false,
      remediationCause: {
        currentSourceHead: snapshot.sourceHead,
        currentTargetHead: intermediateHead,
        kind: "review-basis-drift",
        reviewedBaseHead: snapshot.baseHead,
        reviewedSourceHead: snapshot.sourceHead,
        snapshotId: snapshot.snapshotId,
        sourceBranch: "task/change",
        targetBranch: "main",
      },
    });
    expect(await git(fixture.sourcePath, "rev-parse", "main")).toBe(
      intermediateHead + "\n",
    );
  });

  it("resumes an interrupted merge from the exact recorded approval", async () => {
    const fixture = await prepareCommittedChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    let interrupted = false;
    const command: CommandRunner = async (
      cwd,
      executable,
      arguments_,
      input,
    ) => {
      if (!interrupted && executable === "gitpr" && arguments_[0] === "merge") {
        interrupted = true;
        throw new Error("simulated merge interruption");
      }
      return runCommand(cwd, executable, arguments_, input);
    };

    await expect(
      mergeReviewSnapshot(fixture.change, snapshot, command),
    ).rejects.toThrow(/simulated merge interruption/);
    expect(await git(fixture.sourcePath, "rev-parse", "main")).toBe(
      snapshot.baseHead + "\n",
    );

    await expect(
      mergeReviewSnapshot(fixture.change, snapshot),
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

  it("routes base drift while recording approval to remediation", async () => {
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
      if (!attempted && executable === "gitpr" && arguments_[0] === "approve") {
        attempted = true;
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
      mergeReviewSnapshot(fixture.change, snapshot, command),
    ).resolves.toMatchObject({
      dispositions: { merged: false, remediate: true },
      merged: false,
      remediationCause: {
        currentSourceHead: snapshot.sourceHead,
        currentTargetHead: intermediateHead,
        kind: "review-basis-drift",
        reviewedBaseHead: snapshot.baseHead,
        reviewedSourceHead: snapshot.sourceHead,
        snapshotId: snapshot.snapshotId,
        sourceBranch: "task/change",
        targetBranch: "main",
      },
    });
    expect(attempted).toBe(true);
    expect(await git(fixture.sourcePath, "rev-parse", "main")).toBe(
      intermediateHead + "\n",
    );
  });

  it("approves the exact merge when the base branch is not checked out", async () => {
    const fixture = await prepareCommittedChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    await git(fixture.sourcePath, "switch", "--detach");

    await expect(
      mergeReviewSnapshot(fixture.change, snapshot),
    ).resolves.toMatchObject({ merged: true });
    await expect(
      mergeReviewSnapshot(fixture.change, snapshot),
    ).resolves.toMatchObject({ alreadyMerged: true });
    expect(await git(fixture.sourcePath, "rev-parse", "main")).toBe(
      snapshot.sourceHead + "\n",
    );
    expect(
      await git(
        fixture.sourcePath,
        "for-each-ref",
        "--format=%(refname)",
        "refs/gitpr/index/merged",
      ),
    ).toContain(snapshot.snapshotId);
    expect(
      await git(fixture.sourcePath, "worktree", "list", "--porcelain"),
    ).not.toContain(`${fixture.change.worktreeName}.merge-base`);
  });

  it("replays an exact accepted event without recording another approval", async () => {
    const fixture = await prepareCommittedChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    let interrupted = false;
    let approvals = 0;
    const command: CommandRunner = async (
      cwd,
      executable,
      arguments_,
      input,
    ) => {
      if (executable === "gitpr" && arguments_[0] === "approve") {
        approvals += 1;
        const output = await runCommand(cwd, executable, arguments_, input);
        if (!interrupted) {
          interrupted = true;
          throw new Error("simulated post-approval interruption");
        }
        return output;
      }
      return runCommand(cwd, executable, arguments_, input);
    };

    await expect(
      mergeReviewSnapshot(fixture.change, snapshot, command),
    ).rejects.toThrow(/post-approval interruption/);
    expect(approvals).toBe(1);

    await expect(
      mergeReviewSnapshot(fixture.change, snapshot, command),
    ).resolves.toMatchObject({ merged: true });
    expect(approvals).toBe(1);
  });

  it("records a new approval when the latest accepted event has another basis", async () => {
    const fixture = await prepareCommittedChange();
    const firstSnapshot = await ensureReviewSnapshot(fixture.change);
    await runCommand(fixture.sourcePath, "gitpr", [
      "approve",
      firstSnapshot.snapshotId,
      "--basis",
      `${firstSnapshot.sourceHead}:${firstSnapshot.baseHead}`,
    ]);
    await writeFile(join(fixture.worktreePath, "notes.txt"), "checked\n");
    await git(fixture.worktreePath, "add", "notes.txt");
    await git(fixture.worktreePath, "commit", "--quiet", "-m", "add note");
    const nextSnapshot = await ensureReviewSnapshot(fixture.change);
    expect(nextSnapshot.snapshotId).toBe(firstSnapshot.snapshotId);
    expect(nextSnapshot.latestEvent).toMatchObject({
      baseHead: firstSnapshot.baseHead,
      sourceHead: firstSnapshot.sourceHead,
      verdict: "accepted",
    });

    const approvals: string[][] = [];
    const command: CommandRunner = async (
      cwd,
      executable,
      arguments_,
      input,
    ) => {
      if (executable === "gitpr" && arguments_[0] === "approve") {
        approvals.push(arguments_);
      }
      return runCommand(cwd, executable, arguments_, input);
    };
    await expect(
      mergeReviewSnapshot(fixture.change, nextSnapshot, command),
    ).resolves.toMatchObject({ merged: true });
    expect(approvals).toEqual([
      [
        "approve",
        nextSnapshot.snapshotId,
        "--basis",
        `${nextSnapshot.sourceHead}:${nextSnapshot.baseHead}`,
      ],
    ]);
    expect(
      await readReviewSnapshot(
        fixture.sourcePath,
        nextSnapshot.snapshotId,
        runCommand,
      ),
    ).toMatchObject({
      latestEvent: {
        baseHead: nextSnapshot.baseHead,
        sourceHead: nextSnapshot.sourceHead,
        verdict: "accepted",
      },
      state: "merged",
    });
  });

  it("does not reuse an accepted event for another base head", async () => {
    const fixture = await prepareCommittedChange();
    await writeFile(join(fixture.worktreePath, "notes.txt"), "checked\n");
    await git(fixture.worktreePath, "add", "notes.txt");
    await git(fixture.worktreePath, "commit", "--quiet", "-m", "add note");
    const firstSnapshot = await ensureReviewSnapshot(fixture.change);
    await runCommand(fixture.sourcePath, "gitpr", [
      "approve",
      firstSnapshot.snapshotId,
      "--basis",
      `${firstSnapshot.sourceHead}:${firstSnapshot.baseHead}`,
    ]);
    const nextBase = (
      await git(fixture.sourcePath, "rev-parse", `${firstSnapshot.sourceHead}^`)
    ).trim();
    await git(
      fixture.sourcePath,
      "update-ref",
      "refs/heads/main",
      nextBase,
      firstSnapshot.baseHead,
    );
    await git(fixture.sourcePath, "reset", "--hard", nextBase);
    const nextSnapshot = await ensureReviewSnapshot(fixture.change);
    expect(nextSnapshot).toMatchObject({
      baseHead: nextBase,
      snapshotId: firstSnapshot.snapshotId,
      sourceHead: firstSnapshot.sourceHead,
    });

    const approvals: string[][] = [];
    const command: CommandRunner = async (
      cwd,
      executable,
      arguments_,
      input,
    ) => {
      if (executable === "gitpr" && arguments_[0] === "approve") {
        approvals.push(arguments_);
      }
      return runCommand(cwd, executable, arguments_, input);
    };
    await expect(
      mergeReviewSnapshot(fixture.change, nextSnapshot, command),
    ).resolves.toMatchObject({ merged: true });
    expect(approvals).toEqual([
      [
        "approve",
        nextSnapshot.snapshotId,
        "--basis",
        `${nextSnapshot.sourceHead}:${nextSnapshot.baseHead}`,
      ],
    ]);
  });

  it("routes a conflicting reviewed source to remediation and preserves both branch heads", async () => {
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
      mergeReviewSnapshot(fixture.change, snapshot),
    ).resolves.toMatchObject({
      dispositions: { merged: false, remediate: true },
      remediationCause: {
        currentSourceHead: sourceHead.trim(),
        currentTargetHead: baseHead.trim(),
        kind: "review-source-behind",
        reviewedBaseHead: baseHead.trim(),
        reviewedSourceHead: sourceHead.trim(),
      },
    });
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

    await expect(mergeReviewSnapshot(fixture.change, snapshot)).rejects.toThrow(
      /merge commit/,
    );
    expect(await git(fixture.sourcePath, "rev-parse", "main")).toBe(
      baseHead + "\n",
    );
  });

  it("refuses cleanup while the merged worktree is dirty", async () => {
    const fixture = await prepareCommittedChange();
    const snapshot = await ensureReviewSnapshot(fixture.change);
    await mergeReviewSnapshot(fixture.change, snapshot);
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
    await mergeReviewSnapshot(fixture.change, snapshot);
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
    await mergeReviewSnapshot(fixture.change, snapshot);
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
    await mergeReviewSnapshot(fixture.change, snapshot);
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
    await mergeReviewSnapshot(fixture.change, snapshot);
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
    await mergeReviewSnapshot(fixture.change, snapshot);
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
    await mergeReviewSnapshot(fixture.change, snapshot);
    await git(
      fixture.sourcePath,
      "update-ref",
      "refs/heads/main",
      snapshot.baseHead,
      snapshot.sourceHead,
    );

    await expect(
      mergeReviewSnapshot(fixture.change, snapshot),
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
    await mergeReviewSnapshot(fixture.change, snapshot);
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
    ).rejects.toThrow(/not integrated by an exact approval/);
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

  it("routes pre-snapshot source divergence to remediation without attention", async () => {
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
    ).resolves.toMatchObject({
      awaitingNodeIds: ["remediate"],
      status: "awaiting",
    });
    expect(
      fixture.persistence
        .replayEvents("sample-lifecycle")
        .filter(({ type }) => type === "lifecycle:attention-required"),
    ).toEqual([]);
    expect(
      fixture.persistence.getInstance("sample-lifecycle")?.state
        .flowcraftContext,
    ).toMatchObject({ awaitingNodeIds: ["remediate"] });
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
