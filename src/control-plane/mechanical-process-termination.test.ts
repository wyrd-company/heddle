// ---
// relationships:
//   verifies: heddle
// ---

import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  LifecycleEngine,
  type LifecycleSnapshot,
  type ResumeLifecycleInput,
} from "../engine/index.js";
import { SqlitePersistence } from "../persistence/index.js";
import {
  createMechanicalNodeEffects,
  mechanicalChangeContextKey,
} from "./mechanical-node-effects.js";
import type { MechanicalTerminationBoundary } from "./mechanical-process-termination-worker.js";
import {
  defaultMechanicalCommand,
  readReviewSnapshot,
  type MechanicalChangeContext,
  type ReviewSnapshot,
} from "./review-snapshot.js";

const execute = promisify(execFile);
const workerCwd = process.cwd();
const workerPath = fileURLToPath(
  new URL("./mechanical-process-termination-worker.ts", import.meta.url),
);
const temporaryDirectories: string[] = [];

interface LifecycleFixture {
  approvalWorktreePath: string;
  change: MechanicalChangeContext;
  repositoryRoot: string;
  snapshot: ReviewSnapshot;
  sourceWorktreePath: string;
  stateDirectory: string;
}

interface BoundaryRecord {
  arguments: string[];
  boundary: MechanicalTerminationBoundary;
  executable: string;
  input?: string;
  kind: "boundary";
  phase: "after" | "before";
  pid: number;
}

interface ResultRecord {
  kind: "result";
  result: LifecycleSnapshot;
}

interface ErrorRecord {
  kind: "error";
  message: string;
  name: string;
}

type WorkerRecord = BoundaryRecord | ErrorRecord | ResultRecord;

interface WorkerConfiguration {
  boundary?: MechanicalTerminationBoundary;
  change: MechanicalChangeContext;
  repositoryRoot: string;
  resume: ResumeLifecycleInput;
  stateDirectory: string;
}

interface ProcessRecord {
  arguments: string;
  command: string;
  parentPid: number;
  processGroupId: number;
  processId: number;
}

interface RunningWorker {
  child: ChildProcess;
  exit: Promise<{ code: number | null; signal: string | null }>;
  records: WorkerRecord[];
  stderr: () => string;
  waitForRecord: <T extends WorkerRecord["kind"]>(
    kind: T,
  ) => Promise<Extract<WorkerRecord, { kind: T }>>;
}

const git = async (cwd: string, ...arguments_: string[]): Promise<string> =>
  (await execute("git", arguments_, { cwd })).stdout;

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
};

const withTimeout = async <T>(
  promise: Promise<T>,
  message: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 15_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const launchWorker = async (
  fixture: LifecycleFixture,
  resume: ResumeLifecycleInput,
  boundary?: MechanicalTerminationBoundary,
): Promise<RunningWorker> => {
  const configuration: WorkerConfiguration = {
    boundary,
    change: fixture.change,
    repositoryRoot: fixture.repositoryRoot,
    resume,
    stateDirectory: fixture.stateDirectory,
  };
  const configurationPath = join(
    dirname(fixture.repositoryRoot),
    `worker-${boundary ?? "restart"}.json`,
  );
  await writeFile(configurationPath, JSON.stringify(configuration));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", workerPath, configurationPath],
    {
      cwd: workerCwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (
    child.pid === undefined ||
    child.stdout === null ||
    child.stderr === null
  ) {
    throw new Error("Could not start the process-termination worker");
  }
  const records: WorkerRecord[] = [];
  const waiters = new Set<() => void>();
  let standardError = "";
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() !== "") records.push(JSON.parse(line) as WorkerRecord);
    }
    for (const notify of waiters) notify();
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    standardError += chunk;
  });
  const exit = new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );

  return {
    child,
    exit,
    records,
    stderr: () => standardError,
    waitForRecord: async <T extends WorkerRecord["kind"]>(kind: T) =>
      withTimeout(
        Promise.race([
          new Promise<Extract<WorkerRecord, { kind: T }>>((resolve, reject) => {
            const inspect = (): void => {
              const record = records.find(
                (candidate): candidate is Extract<WorkerRecord, { kind: T }> =>
                  candidate.kind === kind,
              );
              if (record !== undefined) {
                waiters.delete(inspect);
                resolve(record);
                return;
              }
              const error = records.find(
                (candidate): candidate is ErrorRecord =>
                  candidate.kind === "error",
              );
              if (error !== undefined && kind !== "error") {
                waiters.delete(inspect);
                reject(new Error(`${error.name}: ${error.message}`));
              }
            };
            waiters.add(inspect);
            inspect();
          }),
          exit.then(({ code, signal }) => {
            throw new Error(
              `Worker exited before ${kind}: code=${code}, signal=${signal}; stderr: ${standardError}`,
            );
          }),
        ]),
        `Worker did not emit ${kind}`,
      ),
  };
};

const processGroup = async (
  processGroupId: number,
): Promise<ProcessRecord[]> => {
  const output = (await execute("ps", ["-eo", "pid=,ppid=,pgid=,comm=,args="]))
    .stdout;
  return output
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      arguments: match[5] ?? "",
      command: match[4] ?? "",
      parentPid: Number(match[2]),
      processGroupId: Number(match[3]),
      processId: Number(match[1]),
    }))
    .filter((record) => record.processGroupId === processGroupId);
};

const waitForEmptyProcessGroup = async (
  processGroupId: number,
): Promise<ProcessRecord[]> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const remaining = await processGroup(processGroupId);
    if (remaining.length === 0) return remaining;
    await delay(20);
  }
  return processGroup(processGroupId);
};

const waitForProcessGroupSize = async (
  processGroupId: number,
  expectedSize: number,
): Promise<ProcessRecord[]> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const observed = await processGroup(processGroupId);
    if (observed.length === expectedSize) return observed;
    await delay(20);
  }
  return processGroup(processGroupId);
};

const lockFilesBelow = async (root: string): Promise<string[]> => {
  const locks: string[] = [];
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.name.endsWith(".lock")) locks.push(child);
    }
  };
  await visit(root);
  return locks.sort();
};

const readBranchHead = async (
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

const makeLifecycleAtReview = async (
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
    change.repositoryName,
    change.worktreeName,
  );
  const approvalWorktreePath = join(
    worktreesRoot,
    change.repositoryName,
    `${change.worktreeName}.merge-base`,
  );
  const persistence = new SqlitePersistence({ stateDirectory });
  const engine = new LifecycleEngine({
    effects: createMechanicalNodeEffects(),
    persistence,
    repositoryRoot,
  });
  await engine.start({
    blueprintPath: "blueprints/standard-delivery.json",
    initialContext: { [mechanicalChangeContextKey]: change },
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

const makeLifecycleAtRetrospective = async (): Promise<LifecycleFixture> => {
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

const mergeResume: ResumeLifecycleInput = {
  disposition: "approve",
  instanceId: "sample-lifecycle",
  operationId: "review-approved",
};

const cleanupResume: ResumeLifecycleInput = {
  disposition: "complete",
  instanceId: "sample-lifecycle",
  operationId: "retrospective-complete",
};

const terminateAtBoundary = async (
  fixture: LifecycleFixture,
  resume: ResumeLifecycleInput,
  boundary: MechanicalTerminationBoundary,
): Promise<{
  locksBeforeKill: string[];
  marker: BoundaryRecord;
  topologyBeforeKill: ProcessRecord[];
}> => {
  const worker = await launchWorker(fixture, resume, boundary);
  const processGroupId = worker.child.pid!;
  try {
    const marker = await worker.waitForRecord("boundary");
    const holdsLease =
      boundary === "exact-base-leased" || boundary === "approval-recorded";
    const topologyBeforeKill = await waitForProcessGroupSize(
      processGroupId,
      holdsLease ? 2 : 1,
    );
    const locksBeforeKill = await lockFilesBelow(
      join(fixture.repositoryRoot, ".git"),
    );
    expect(worker.child.kill("SIGKILL")).toBe(true);
    await expect(worker.exit).resolves.toEqual({
      code: null,
      signal: "SIGKILL",
    });
    const remaining = await waitForEmptyProcessGroup(processGroupId);
    expect(
      remaining,
      `orphaned process group:\n${JSON.stringify(remaining, null, 2)}`,
    ).toEqual([]);
    expect(await lockFilesBelow(join(fixture.repositoryRoot, ".git"))).toEqual(
      [],
    );
    return { locksBeforeKill, marker, topologyBeforeKill };
  } finally {
    const remaining = await processGroup(processGroupId);
    if (remaining.length > 0) process.kill(-processGroupId, "SIGKILL");
  }
};

const restartOperation = async (
  fixture: LifecycleFixture,
  resume: ResumeLifecycleInput,
): Promise<LifecycleSnapshot> => {
  const worker = await launchWorker(fixture, resume);
  const result = await worker.waitForRecord("result");
  const exited = await worker.exit;
  expect(exited, worker.stderr()).toEqual({ code: 0, signal: null });
  return result.result;
};

const restartExpectingAttention = async (
  fixture: LifecycleFixture,
  resume: ResumeLifecycleInput,
): Promise<ErrorRecord> => {
  const worker = await launchWorker(fixture, resume);
  const error = await worker.waitForRecord("error");
  const exited = await worker.exit;
  expect(exited).toEqual({ code: 1, signal: null });
  return error;
};

const snapshotNow = (fixture: LifecycleFixture): Promise<ReviewSnapshot> =>
  readReviewSnapshot(
    fixture.repositoryRoot,
    fixture.snapshot.snapshotId,
    defaultMechanicalCommand,
  );

const assertOwnedWorktree = async (
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

const transitionBoundaries: Array<{
  argumentPrefix: string[];
  boundary: MechanicalTerminationBoundary;
  detachedBase: boolean;
  executable: string;
  expectedApprovalPathAtKill: boolean;
  expectedBranchAtKill: boolean;
  expectedSnapshotStatusAtKill: ReviewSnapshot["status"];
  expectedSourcePathAtKill: boolean;
  phase: BoundaryRecord["phase"];
  transition: "cleanup" | "merge";
}> = [
  {
    argumentPrefix: ["update-ref", "--stdin"],
    boundary: "exact-base-integrated",
    detachedBase: false,
    executable: "git",
    expectedApprovalPathAtKill: false,
    expectedBranchAtKill: true,
    expectedSnapshotStatusAtKill: "open",
    expectedSourcePathAtKill: true,
    phase: "after",
    transition: "merge",
  },
  {
    argumentPrefix: ["worktree", "add"],
    boundary: "approval-worktree-provisioned",
    detachedBase: true,
    executable: "git",
    expectedApprovalPathAtKill: true,
    expectedBranchAtKill: true,
    expectedSnapshotStatusAtKill: "open",
    expectedSourcePathAtKill: true,
    phase: "after",
    transition: "merge",
  },
  {
    argumentPrefix: ["merge"],
    boundary: "exact-base-leased",
    detachedBase: true,
    executable: "gitpr",
    expectedApprovalPathAtKill: true,
    expectedBranchAtKill: true,
    expectedSnapshotStatusAtKill: "open",
    expectedSourcePathAtKill: true,
    phase: "before",
    transition: "merge",
  },
  {
    argumentPrefix: ["merge"],
    boundary: "approval-recorded",
    detachedBase: true,
    executable: "gitpr",
    expectedApprovalPathAtKill: true,
    expectedBranchAtKill: true,
    expectedSnapshotStatusAtKill: "approved",
    expectedSourcePathAtKill: true,
    phase: "after",
    transition: "merge",
  },
  {
    argumentPrefix: ["worktree", "remove", "--"],
    boundary: "approval-worktree-removed",
    detachedBase: true,
    executable: "git",
    expectedApprovalPathAtKill: false,
    expectedBranchAtKill: true,
    expectedSnapshotStatusAtKill: "approved",
    expectedSourcePathAtKill: true,
    phase: "after",
    transition: "merge",
  },
  {
    argumentPrefix: ["worktree", "remove", "--"],
    boundary: "source-worktree-removed",
    detachedBase: false,
    executable: "git",
    expectedApprovalPathAtKill: false,
    expectedBranchAtKill: true,
    expectedSnapshotStatusAtKill: "approved",
    expectedSourcePathAtKill: false,
    phase: "after",
    transition: "cleanup",
  },
  {
    argumentPrefix: ["update-ref", "--stdin"],
    boundary: "cleanup-ref-deleted",
    detachedBase: false,
    executable: "git",
    expectedApprovalPathAtKill: false,
    expectedBranchAtKill: false,
    expectedSnapshotStatusAtKill: "approved",
    expectedSourcePathAtKill: false,
    phase: "after",
    transition: "cleanup",
  },
];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("mechanical process-termination recovery", { timeout: 30_000 }, () => {
  it.each(transitionBoundaries)(
    "restarts $boundary with exact durable resource evidence",
    async (boundaryCase) => {
      const fixture =
        boundaryCase.transition === "merge"
          ? await makeLifecycleAtReview(boundaryCase.detachedBase)
          : await makeLifecycleAtRetrospective();
      const resume =
        boundaryCase.transition === "merge" ? mergeResume : cleanupResume;
      const killed = await terminateAtBoundary(
        fixture,
        resume,
        boundaryCase.boundary,
      );

      expect(killed.marker).toMatchObject({
        boundary: boundaryCase.boundary,
        executable: boundaryCase.executable,
        kind: "boundary",
        phase: boundaryCase.phase,
      });
      expect(
        killed.marker.arguments.slice(0, boundaryCase.argumentPrefix.length),
      ).toEqual(boundaryCase.argumentPrefix);
      if (boundaryCase.boundary === "exact-base-integrated") {
        expect(killed.marker.input).toContain(
          `update refs/heads/${fixture.change.baseBranch} ${fixture.snapshot.sourceHead} ${fixture.snapshot.baseHead}`,
        );
      }
      if (boundaryCase.boundary === "cleanup-ref-deleted") {
        expect(killed.marker.input).toContain(
          `delete refs/heads/${fixture.change.branch} ${fixture.snapshot.sourceHead}`,
        );
      }
      if (
        boundaryCase.boundary === "approval-worktree-provisioned" ||
        boundaryCase.boundary === "approval-worktree-removed"
      ) {
        expect(killed.marker.arguments).toContain(fixture.approvalWorktreePath);
      }
      if (boundaryCase.boundary === "source-worktree-removed") {
        expect(killed.marker.arguments.at(-1)).toBe(fixture.sourceWorktreePath);
      }
      expect(killed.topologyBeforeKill).toContainEqual(
        expect.objectContaining({ processId: killed.marker.pid }),
      );
      const leaseProcesses = killed.topologyBeforeKill.filter(
        ({ arguments: arguments_, command }) =>
          command === "git" && arguments_.includes("update-ref --stdin"),
      );
      if (
        boundaryCase.boundary === "exact-base-leased" ||
        boundaryCase.boundary === "approval-recorded"
      ) {
        expect(leaseProcesses).toHaveLength(1);
        expect(leaseProcesses[0]).toMatchObject({
          parentPid: killed.marker.pid,
        });
        expect(
          killed.topologyBeforeKill,
          JSON.stringify(killed.topologyBeforeKill, null, 2),
        ).toHaveLength(2);
        expect(
          killed.locksBeforeKill.some((path) => path.endsWith("main.lock")),
        ).toBe(true);
      } else {
        expect(leaseProcesses).toHaveLength(0);
        expect(
          killed.topologyBeforeKill,
          JSON.stringify(killed.topologyBeforeKill, null, 2),
        ).toHaveLength(1);
        expect(killed.locksBeforeKill).toEqual([]);
      }

      expect(await readBranchHead(fixture.repositoryRoot, "main")).toBe(
        fixture.snapshot.sourceHead,
      );
      expect(
        await readBranchHead(fixture.repositoryRoot, fixture.change.branch),
      ).toBe(
        boundaryCase.expectedBranchAtKill
          ? fixture.snapshot.sourceHead
          : undefined,
      );
      expect(await pathExists(fixture.sourceWorktreePath)).toBe(
        boundaryCase.expectedSourcePathAtKill,
      );
      expect(await pathExists(fixture.approvalWorktreePath)).toBe(
        boundaryCase.expectedApprovalPathAtKill,
      );
      if (boundaryCase.expectedSourcePathAtKill) {
        await assertOwnedWorktree(
          fixture,
          fixture.sourceWorktreePath,
          fixture.change.branch,
        );
      }
      if (boundaryCase.expectedApprovalPathAtKill) {
        await assertOwnedWorktree(
          fixture,
          fixture.approvalWorktreePath,
          fixture.change.baseBranch,
        );
      }
      expect((await snapshotNow(fixture)).status).toBe(
        boundaryCase.expectedSnapshotStatusAtKill,
      );
      const interruptedPersistence = new SqlitePersistence({
        stateDirectory: fixture.stateDirectory,
      });
      expect(
        interruptedPersistence.getInstance("sample-lifecycle")?.state
          .flowcraftContext,
      ).toMatchObject({
        pendingTransition: { operationId: resume.operationId },
      });
      interruptedPersistence.close();

      const recovered = await restartOperation(fixture, resume);
      if (boundaryCase.transition === "merge") {
        expect(recovered).toMatchObject({
          awaitingNodeIds: ["retrospective"],
          status: "awaiting",
        });
        expect(
          await readBranchHead(fixture.repositoryRoot, fixture.change.branch),
        ).toBe(fixture.snapshot.sourceHead);
        expect(await pathExists(fixture.sourceWorktreePath)).toBe(true);
      } else {
        expect(recovered).toMatchObject({
          awaitingNodeIds: [],
          status: "completed",
        });
        expect(
          await readBranchHead(fixture.repositoryRoot, fixture.change.branch),
        ).toBe(undefined);
        expect(await pathExists(fixture.sourceWorktreePath)).toBe(false);
      }
      expect(await readBranchHead(fixture.repositoryRoot, "main")).toBe(
        fixture.snapshot.sourceHead,
      );
      expect((await snapshotNow(fixture)).status).toBe("approved");
      expect(await pathExists(fixture.approvalWorktreePath)).toBe(false);
      expect(
        await git(fixture.repositoryRoot, "rev-list", "--merges", "main"),
      ).toBe("");
    },
  );

  it("routes reviewed-base drift after exact-base integration to remediation", async () => {
    const fixture = await makeLifecycleAtReview();
    await terminateAtBoundary(fixture, mergeResume, "exact-base-integrated");
    const tree = (
      await git(
        fixture.repositoryRoot,
        "rev-parse",
        `${fixture.snapshot.sourceHead}^{tree}`,
      )
    ).trim();
    const movedBase = (
      await git(
        fixture.repositoryRoot,
        "commit-tree",
        tree,
        "-p",
        fixture.snapshot.sourceHead,
        "-m",
        "advance base",
      )
    ).trim();
    await git(
      fixture.repositoryRoot,
      "update-ref",
      "refs/heads/main",
      movedBase,
      fixture.snapshot.sourceHead,
    );

    await expect(restartOperation(fixture, mergeResume)).resolves.toMatchObject(
      {
        awaitingNodeIds: ["remediate"],
        status: "awaiting",
      },
    );
    expect((await snapshotNow(fixture)).status).toBe("open");
    expect(await readBranchHead(fixture.repositoryRoot, "main")).toBe(
      movedBase,
    );
    expect(
      await readBranchHead(fixture.repositoryRoot, fixture.change.branch),
    ).toBe(fixture.snapshot.sourceHead);
    expect(await pathExists(fixture.sourceWorktreePath)).toBe(true);
  });

  it("enters attention and restores the owned path when the surviving branch moves", async () => {
    const fixture = await makeLifecycleAtRetrospective();
    await terminateAtBoundary(
      fixture,
      cleanupResume,
      "source-worktree-removed",
    );
    const tree = (
      await git(
        fixture.repositoryRoot,
        "rev-parse",
        `${fixture.snapshot.sourceHead}^{tree}`,
      )
    ).trim();
    const movedBranch = (
      await git(
        fixture.repositoryRoot,
        "commit-tree",
        tree,
        "-p",
        fixture.snapshot.sourceHead,
        "-m",
        "advance source",
      )
    ).trim();
    await git(
      fixture.repositoryRoot,
      "update-ref",
      `refs/heads/${fixture.change.branch}`,
      movedBranch,
      fixture.snapshot.sourceHead,
    );

    await expect(
      restartExpectingAttention(fixture, cleanupResume),
    ).resolves.toMatchObject({ name: "UnexpectedLandingError" });
    expect(
      await readBranchHead(fixture.repositoryRoot, fixture.change.branch),
    ).toBe(movedBranch);
    expect(await pathExists(fixture.sourceWorktreePath)).toBe(true);
    expect(
      await git(fixture.sourceWorktreePath, "symbolic-ref", "--short", "HEAD"),
    ).toBe(`${fixture.change.branch}\n`);
    expect((await snapshotNow(fixture)).status).toBe("approved");
    const persistence = new SqlitePersistence({
      stateDirectory: fixture.stateDirectory,
    });
    expect(
      persistence
        .replayEvents("sample-lifecycle")
        .filter(({ type }) => type === "lifecycle:attention-required"),
    ).toHaveLength(1);
    persistence.close();
  });
});
