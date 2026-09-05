// ---
// relationships:
//   validates: heddle
// ---

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { LifecycleEngine } from "../engine/index.js";
import { writeDeliveryBlueprintFixture } from "../engine/lifecycle-blueprint.test-support.js";
import { advanceOperationId } from "../mcp-server/operations.js";
import { SqlitePersistence } from "../persistence/index.js";
import { readProductionHandoffStage } from "./stage-handoff.js";

const driftCause = {
  currentSourceHead: "c".repeat(40),
  currentTargetHead: "d".repeat(40),
  kind: "review-basis-drift" as const,
  reviewedBaseHead: "b".repeat(40),
  reviewedSourceHead: "a".repeat(40),
  snapshotId: "SAMPLE1",
  sourceBranch: "task/change",
  targetBranch: "main",
};
const laterDriftCause = {
  ...driftCause,
  currentSourceHead: "e".repeat(40),
  currentTargetHead: "f".repeat(40),
  reviewedBaseHead: "d".repeat(40),
  reviewedSourceHead: "e".repeat(40),
  snapshotId: "SAMPLE2",
};
const sourceBehindCause = {
  ...driftCause,
  currentSourceHead: driftCause.reviewedSourceHead,
  currentTargetHead: driftCause.reviewedBaseHead,
  kind: "review-source-behind" as const,
};

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("production stage handoff", () => {
  it("carries a mechanical snapshot identity into the review handoff", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "stage-handoff-"));
    temporaryDirectories.push(repositoryRoot);
    await executeFile("git", ["init", "--quiet"], { cwd: repositoryRoot });
    await mkdir(join(repositoryRoot, "blueprints"));
    await writeDeliveryBlueprintFixture(repositoryRoot, "standard-delivery");
    const persistence = new SqlitePersistence({
      stateDirectory: join(repositoryRoot, "state"),
    });
    const engine = new LifecycleEngine({
      effects: {
        finalize: async () => ({}),
        merge: async () => ({}),
        "prepare-worktree": async () => ({ prepared: true }),
        "review-snapshot": async () => ({ snapshotId: "snapshot-sample" }),
      },
      persistence,
      repositoryRoot,
    });
    const instanceId = "sample-instance";
    const sessionKey = `${instanceId}:implement:1`;
    await engine.start({
      blueprintPath: "blueprints/standard-delivery.json",
      instanceId,
    });
    persistence.writeSessionRuntime({
      activation: 1,
      instanceId,
      sessionKey,
      stageId: "implement",
      threadId: "sample-thread",
    });
    await engine.resume({
      disposition: "complete",
      instanceId,
      operationId: advanceOperationId(sessionKey),
      output: { result: "ready" },
    });

    const review = await readProductionHandoffStage({
      instanceId,
      persistence,
      repositoryRoot,
      stageId: "review",
    });

    expect(review.handoff).toMatchObject({
      kind: "standard",
      name: "review",
      priorStageOutputs: [
        { result: "ready" },
        { snapshotId: "snapshot-sample" },
      ],
    });
    persistence.close();
  });

  it.each([
    {
      firstDisposition: "approve",
      firstOutput: undefined,
      driftCauses: [driftCause],
      label: "later review findings over stale drift",
      secondDisposition: "reject",
      secondOutput: {
        findings: [{ code: "P1", summary: "A recorded value is unchecked" }],
      },
      expectedCause: { kind: "review-findings" },
      expectedFindings: [
        { code: "P1", summary: "A recorded value is unchecked" },
      ],
    },
    {
      firstDisposition: "reject",
      firstOutput: {
        findings: [{ code: "P1", summary: "A recorded value is unchecked" }],
      },
      driftCauses: [laterDriftCause],
      label: "current drift over earlier review findings",
      secondDisposition: "approve",
      secondOutput: undefined,
      expectedCause: laterDriftCause,
      expectedFindings: [],
    },
    {
      firstDisposition: "approve",
      firstOutput: undefined,
      driftCauses: [driftCause, laterDriftCause],
      label: "latest drift across consecutive mechanical drift loops",
      secondDisposition: "approve",
      secondOutput: undefined,
      expectedCause: laterDriftCause,
      expectedFindings: [],
    },
    {
      firstDisposition: "approve",
      firstOutput: undefined,
      driftCauses: [sourceBehindCause],
      label: "current already-behind integration cause",
      secondDisposition: "approve",
      secondOutput: undefined,
      expectedCause: sourceBehindCause,
      expectedFindings: [],
    },
  ])(
    "selects $label across remediation loops",
    async ({
      expectedCause,
      expectedFindings,
      firstDisposition,
      firstOutput,
      driftCauses,
      secondDisposition,
      secondOutput,
    }) => {
      const repositoryRoot = await mkdtemp(join(tmpdir(), "stage-handoff-"));
      temporaryDirectories.push(repositoryRoot);
      await executeFile("git", ["init", "--quiet"], { cwd: repositoryRoot });
      await mkdir(join(repositoryRoot, "blueprints"));
      await writeDeliveryBlueprintFixture(repositoryRoot, "standard-delivery");
      const persistence = new SqlitePersistence({
        stateDirectory: join(repositoryRoot, "state"),
      });
      let mergeActivation = 0;
      let reviewSnapshotActivation = 0;
      const engine = new LifecycleEngine({
        effects: {
          finalize: async () => ({}),
          merge: async () => {
            const cause =
              driftCauses[Math.min(mergeActivation, driftCauses.length - 1)]!;
            mergeActivation += 1;
            return {
              alreadyMerged: false,
              dispositions: { merged: false, remediate: true },
              merged: false,
              remediationCause: cause,
              snapshotId: cause.snapshotId,
            };
          },
          "prepare-worktree": async () => ({ prepared: true }),
          "review-snapshot": async () => {
            reviewSnapshotActivation += 1;
            return {
              snapshotId:
                reviewSnapshotActivation === 1 ? "SAMPLE1" : "SAMPLE2",
            };
          },
        },
        persistence,
        repositoryRoot,
      });
      const instanceId = "sample-instance";
      await engine.start({
        blueprintPath: "blueprints/standard-delivery.json",
        instanceId,
      });
      const recordSession = (stageId: string, activation: number): string => {
        const sessionKey = `${instanceId}:${stageId}:${activation}`;
        persistence.writeSessionRuntime({
          activation,
          instanceId,
          sessionKey,
          stageId,
          threadId: `${stageId}-thread-${activation}`,
        });
        return sessionKey;
      };
      const implement = recordSession("implement", 1);
      await engine.resume({
        disposition: "complete",
        instanceId,
        operationId: advanceOperationId(implement),
      });
      const firstReview = recordSession("review", 1);
      await engine.resume({
        disposition: firstDisposition,
        instanceId,
        operationId: advanceOperationId(firstReview),
        ...(firstOutput === undefined ? {} : { output: firstOutput }),
      });
      const firstRemediation = recordSession("remediate", 1);
      await engine.resume({
        disposition: "complete",
        instanceId,
        operationId: advanceOperationId(firstRemediation),
      });
      const secondReview = recordSession("review", 2);
      await engine.resume({
        disposition: secondDisposition,
        instanceId,
        operationId: advanceOperationId(secondReview),
        ...(secondOutput === undefined ? {} : { output: secondOutput }),
      });
      recordSession("remediate", 2);

      await expect(
        readProductionHandoffStage({
          instanceId,
          persistence,
          repositoryRoot,
          stageId: "remediate",
        }),
      ).resolves.toMatchObject({
        handoff: {
          cause: expectedCause,
          kind: "remediation",
          review: { findings: expectedFindings },
        },
      });
      persistence.close();
    },
  );

  it.each([
    {
      label: "a missing current source",
      mechanicalOutput: {
        alreadyMerged: false,
        dispositions: { merged: false, remediate: true },
        merged: false,
        remediationCause: {
          ...driftCause,
          currentSourceHead: null,
        },
        snapshotId: driftCause.snapshotId,
      },
    },
    {
      label: "a missing current target",
      mechanicalOutput: {
        alreadyMerged: false,
        dispositions: { merged: false, remediate: true },
        merged: false,
        remediationCause: {
          ...driftCause,
          currentTargetHead: null,
        },
        snapshotId: driftCause.snapshotId,
      },
    },
    {
      label: "a numeric snapshot identity",
      mechanicalOutput: {
        alreadyMerged: false,
        dispositions: { merged: false, remediate: true },
        merged: false,
        remediationCause: {
          ...driftCause,
          snapshotId: 1,
        },
        snapshotId: 1,
      },
    },
    {
      label: "an invalid current target",
      mechanicalOutput: {
        alreadyMerged: false,
        dispositions: { merged: false, remediate: true },
        merged: false,
        remediationCause: {
          ...driftCause,
          currentTargetHead: "not-an-object-id",
        },
        snapshotId: driftCause.snapshotId,
      },
    },
    {
      label: "a mismatched outer snapshot identity",
      mechanicalOutput: {
        alreadyMerged: false,
        dispositions: { merged: false, remediate: true },
        merged: false,
        remediationCause: driftCause,
        snapshotId: "SAMPLE2",
      },
    },
    {
      label: "an unknown integration cause",
      mechanicalOutput: {
        alreadyMerged: false,
        dispositions: { merged: false, remediate: true },
        merged: false,
        remediationCause: {
          ...sourceBehindCause,
          kind: "unclassified-integration",
        },
        snapshotId: sourceBehindCause.snapshotId,
      },
    },
    {
      label: "a source-behind cause with a moved current target",
      mechanicalOutput: {
        alreadyMerged: false,
        dispositions: { merged: false, remediate: true },
        merged: false,
        remediationCause: {
          ...sourceBehindCause,
          currentTargetHead: "f".repeat(40),
        },
        snapshotId: sourceBehindCause.snapshotId,
      },
    },
  ])(
    "keeps the legacy missing-findings fallback for $label",
    async ({ mechanicalOutput }) => {
      const repositoryRoot = await mkdtemp(join(tmpdir(), "stage-handoff-"));
      temporaryDirectories.push(repositoryRoot);
      await executeFile("git", ["init", "--quiet"], { cwd: repositoryRoot });
      await mkdir(join(repositoryRoot, "blueprints"));
      await writeDeliveryBlueprintFixture(repositoryRoot, "standard-delivery");
      const persistence = new SqlitePersistence({
        stateDirectory: join(repositoryRoot, "state"),
      });
      const engine = new LifecycleEngine({
        effects: {
          finalize: async () => ({}),
          merge: async () => mechanicalOutput,
          "prepare-worktree": async () => ({ prepared: true }),
          "review-snapshot": async () => ({ snapshotId: "SAMPLE1" }),
        },
        persistence,
        repositoryRoot,
      });
      const instanceId = "sample-instance";
      await engine.start({
        blueprintPath: "blueprints/standard-delivery.json",
        instanceId,
      });
      for (const [stageId, disposition, activation] of [
        ["implement", "complete", 1],
        ["review", "approve", 1],
      ] as const) {
        const sessionKey = `${instanceId}:${stageId}:${activation}`;
        persistence.writeSessionRuntime({
          activation,
          instanceId,
          sessionKey,
          stageId,
          threadId: `${stageId}-thread-${activation}`,
        });
        await engine.resume({
          disposition,
          instanceId,
          operationId: advanceOperationId(sessionKey),
        });
      }

      await expect(
        readProductionHandoffStage({
          instanceId,
          persistence,
          repositoryRoot,
          stageId: "remediate",
        }),
      ).resolves.toMatchObject({
        contractIssue: { field: "findings", priorStageId: "review" },
        handoff: {
          kind: "remediation",
          review: { findings: [] },
        },
      });
      const handoff = await readProductionHandoffStage({
        instanceId,
        persistence,
        repositoryRoot,
        stageId: "remediate",
      });
      expect(handoff.handoff).not.toHaveProperty("cause");
      persistence.close();
    },
  );
});
