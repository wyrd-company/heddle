// ---
// relationships:
//   verifies: heddle
// ---

import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import {
  readProcessGroup,
  readRepositoryRefLocks,
} from "./mechanical-process-topology.js";
import {
  restartExpectingAttention,
  restartOperation,
  terminateAtBoundary,
} from "./mechanical-process-termination-client.js";
import {
  assertOwnedWorktree,
  cleanupTerminationFixtures,
  git,
  makeLifecycleAtReview,
  mergeResume,
  pathExists,
  readBranchHead,
  snapshotNow,
} from "./mechanical-process-termination-fixture.js";

afterEach(cleanupTerminationFixtures);

describe(
  "mechanical process-termination remediation",
  { timeout: 30_000 },
  () => {
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

      await expect(
        restartOperation(fixture, mergeResume),
      ).resolves.toMatchObject({
        awaitingNodeIds: ["remediate"],
        status: "awaiting",
      });
      expect((await snapshotNow(fixture)).status).toBe("open");
      expect(await readBranchHead(fixture.repositoryRoot, "main")).toBe(
        movedBase,
      );
      expect(
        await readBranchHead(fixture.repositoryRoot, fixture.change.branch),
      ).toBe(fixture.snapshot.sourceHead);
      expect(await pathExists(fixture.sourceWorktreePath)).toBe(true);
      expect(
        await git(fixture.repositoryRoot, "status", "--porcelain=v1"),
      ).toBe("");
    });

    it("routes reviewed-source drift after exact-base integration to remediation", async () => {
      const fixture = await makeLifecycleAtReview();
      await terminateAtBoundary(fixture, mergeResume, "exact-base-integrated");
      const tree = (
        await git(
          fixture.repositoryRoot,
          "rev-parse",
          `${fixture.snapshot.sourceHead}^{tree}`,
        )
      ).trim();
      const movedSource = (
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
        movedSource,
        fixture.snapshot.sourceHead,
      );

      await expect(
        restartOperation(fixture, mergeResume),
      ).resolves.toMatchObject({
        awaitingNodeIds: ["remediate"],
        status: "awaiting",
      });
      expect((await snapshotNow(fixture)).status).toBe("open");
      expect(await readBranchHead(fixture.repositoryRoot, "main")).toBe(
        fixture.snapshot.sourceHead,
      );
      expect(
        await readBranchHead(fixture.repositoryRoot, fixture.change.branch),
      ).toBe(movedSource);
      await assertOwnedWorktree(
        fixture,
        fixture.sourceWorktreePath,
        fixture.change.branch,
      );
      expect(await pathExists(fixture.approvalWorktreePath)).toBe(false);
      expect(
        await git(fixture.repositoryRoot, "status", "--porcelain=v1"),
      ).toBe("");
    });

    it("kills the restart process group and ref lease when recovery times out", async () => {
      const fixture = await makeLifecycleAtReview(true);
      let processGroupId: number | undefined;
      try {
        await expect(
          restartOperation(fixture, mergeResume, {
            boundary: "exact-base-leased",
            onLaunch: (launchedProcessGroupId) => {
              processGroupId = launchedProcessGroupId;
            },
            timeoutMilliseconds: 250,
            withStubbornDescendant: true,
          }),
        ).rejects.toThrow("Worker did not emit result");
        expect(processGroupId).toBeDefined();
        expect(await readProcessGroup(processGroupId!)).toEqual([]);
        expect(await readRepositoryRefLocks(fixture)).toEqual([]);
      } finally {
        if (processGroupId !== undefined) {
          try {
            process.kill(-processGroupId, "SIGKILL");
          } catch (error) {
            expect((error as { code?: string }).code).toBe("ESRCH");
          }
        }
      }
    });

    it("kills the attention restart process group and ref lease when recovery times out", async () => {
      const fixture = await makeLifecycleAtReview(true);
      let processGroupId: number | undefined;
      try {
        await expect(
          restartExpectingAttention(fixture, mergeResume, {
            boundary: "exact-base-leased",
            onLaunch: (launchedProcessGroupId) => {
              processGroupId = launchedProcessGroupId;
            },
            timeoutMilliseconds: 250,
            withStubbornDescendant: true,
          }),
        ).rejects.toThrow("Worker did not emit error");
        expect(processGroupId).toBeDefined();
        expect(await readProcessGroup(processGroupId!)).toEqual([]);
        expect(await readRepositoryRefLocks(fixture)).toEqual([]);
      } finally {
        if (processGroupId !== undefined) {
          try {
            process.kill(-processGroupId, "SIGKILL");
          } catch (error) {
            expect((error as { code?: string }).code).toBe("ESRCH");
          }
        }
      }
    });
  },
);
