// ---
// relationships:
//   verifies: heddle
// ---

import { afterEach, describe, expect, it } from "vitest";

import { SqlitePersistence } from "../persistence/index.js";
import {
  restartExpectingAttention,
  restartOperation,
  terminateAtBoundary,
  type BoundaryRecord,
} from "./mechanical-process-termination-client.js";
import {
  assertOwnedWorktree,
  cleanupResume,
  cleanupTerminationFixtures,
  git,
  makeLifecycleAtRetrospective,
  makeLifecycleAtReview,
  mergeResume,
  pathExists,
  readBranchHead,
  snapshotNow,
} from "./mechanical-process-termination-fixture.js";
import type { MechanicalTerminationBoundary } from "./mechanical-process-termination-worker.js";
import type { ReviewSnapshot } from "./review-snapshot.js";

const transitionBoundaries: Array<{
  argumentPrefix: string[];
  boundary: MechanicalTerminationBoundary;
  detachedBase: boolean;
  executable: string;
  expectedApprovalPathAtKill: boolean;
  expectedBaseWorktreeCleanAtKill: boolean;
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
    expectedBaseWorktreeCleanAtKill: false,
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
    expectedBaseWorktreeCleanAtKill: true,
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
    expectedBaseWorktreeCleanAtKill: true,
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
    expectedBaseWorktreeCleanAtKill: true,
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
    expectedBaseWorktreeCleanAtKill: true,
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
    expectedBaseWorktreeCleanAtKill: true,
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
    expectedBaseWorktreeCleanAtKill: true,
    expectedBranchAtKill: false,
    expectedSnapshotStatusAtKill: "approved",
    expectedSourcePathAtKill: false,
    phase: "after",
    transition: "cleanup",
  },
];

afterEach(cleanupTerminationFixtures);

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
      const transformProcesses = killed.topologyBeforeKill.filter(
        ({ arguments: arguments_, command, parentPid }) =>
          command === "esbuild" &&
          parentPid === killed.marker.pid &&
          arguments_.includes("/node_modules/") &&
          arguments_.includes("esbuild --service=") &&
          arguments_.endsWith(" --ping"),
      );
      expect(transformProcesses.length).toBeLessThanOrEqual(1);
      if (
        boundaryCase.boundary === "exact-base-leased" ||
        boundaryCase.boundary === "approval-recorded"
      ) {
        expect(leaseProcesses).toHaveLength(1);
        expect(leaseProcesses[0]).toMatchObject({
          parentPid: killed.marker.pid,
        });
        expect(
          killed.locksBeforeKill.some((path) => path.endsWith("main.lock")),
        ).toBe(true);
      } else {
        expect(leaseProcesses).toHaveLength(0);
        expect(killed.locksBeforeKill).toEqual([]);
      }
      expect(
        killed.topologyBeforeKill,
        JSON.stringify(killed.topologyBeforeKill, null, 2),
      ).toHaveLength(1 + leaseProcesses.length + transformProcesses.length);

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
      expect(
        (await git(fixture.repositoryRoot, "status", "--porcelain=v1")) === "",
      ).toBe(boundaryCase.expectedBaseWorktreeCleanAtKill);
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
        await git(fixture.repositoryRoot, "status", "--porcelain=v1"),
      ).toBe("");
      expect(
        await git(fixture.repositoryRoot, "rev-list", "--merges", "main"),
      ).toBe("");
    },
  );

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
