// ---
// relationships:
//   validates: heddle
// ---

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];

const binding = (sessionKey: string, threadId: string) => ({
  alias: "primary",
  candidatePosition: 1,
  driverKind: "codex",
  interactionMode: "default",
  modelSlug: "sample-model",
  observedCliVersion: "sample-version",
  providerDisplayName: "Workbench Alpha",
  providerInstanceId: "provider-alpha",
  runtimeMode: "auto" as const,
  sessionKey,
  skippedCandidates: [],
  threadId,
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("production stage handoff", () => {
  it("reads provider selection from the pinned wait stage", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "stage-selection-"));
    temporaryDirectories.push(repositoryRoot);
    await executeFile("git", ["init", "--quiet"], { cwd: repositoryRoot });
    await mkdir(join(repositoryRoot, "blueprints"));
    const blueprintPath = await writeDeliveryBlueprintFixture(
      repositoryRoot,
      "standard-delivery",
    );
    const blueprint = JSON.parse(
      await readFile(join(repositoryRoot, blueprintPath), "utf8"),
    ) as {
      nodes: Array<{
        id: string;
        "provider-alias"?: string;
        "runtime-mode"?: string;
      }>;
    };
    const review = blueprint.nodes.find(({ id }) => id === "review")!;
    review["provider-alias"] = "reviewer";
    review["runtime-mode"] = "full-access";
    await writeFile(
      join(repositoryRoot, blueprintPath),
      `${JSON.stringify(blueprint, null, 2)}\n`,
    );
    const persistence = new SqlitePersistence({
      stateDirectory: join(repositoryRoot, "state"),
    });
    const engine = new LifecycleEngine({
      effects: {
        finalize: async () => ({}),
        merge: async () => ({}),
        "prepare-worktree": async () => ({}),
        "review-snapshot": async () => ({}),
      },
      persistence,
      repositoryRoot,
    });
    await engine.start({
      blueprintPath,
      instanceId: "sample-instance",
    });

    await expect(
      readProductionHandoffStage({
        instanceId: "sample-instance",
        persistence,
        repositoryRoot,
        stageId: "review",
      }),
    ).resolves.toMatchObject({
      providerAlias: "reviewer",
      runtimeMode: "full-access",
    });
    persistence.close();
  });

  it("reads provider selection from a pinned remediation stage", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "stage-selection-"));
    temporaryDirectories.push(repositoryRoot);
    await executeFile("git", ["init", "--quiet"], { cwd: repositoryRoot });
    await mkdir(join(repositoryRoot, "blueprints"));
    const blueprintPath = await writeDeliveryBlueprintFixture(
      repositoryRoot,
      "standard-delivery",
    );
    const blueprint = JSON.parse(
      await readFile(join(repositoryRoot, blueprintPath), "utf8"),
    ) as {
      nodes: Array<{
        id: string;
        "provider-alias"?: string;
        "runtime-mode"?: string;
      }>;
    };
    const remediation = blueprint.nodes.find(({ id }) => id === "remediate")!;
    remediation["provider-alias"] = "primary";
    remediation["runtime-mode"] = "auto-accept-edits";
    await writeFile(
      join(repositoryRoot, blueprintPath),
      `${JSON.stringify(blueprint, null, 2)}\n`,
    );
    const persistence = new SqlitePersistence({
      stateDirectory: join(repositoryRoot, "state"),
    });
    const engine = new LifecycleEngine({
      effects: {
        finalize: async () => ({}),
        merge: async () => ({}),
        "prepare-worktree": async () => ({}),
        "review-snapshot": async () => ({}),
      },
      persistence,
      repositoryRoot,
    });
    await engine.start({
      blueprintPath,
      instanceId: "sample-instance",
    });

    await expect(
      readProductionHandoffStage({
        instanceId: "sample-instance",
        persistence,
        repositoryRoot,
        stageId: "remediate",
      }),
    ).resolves.toMatchObject({
      providerAlias: "primary",
      runtimeMode: "auto-accept-edits",
    });
    persistence.close();
  });

  it("carries a mechanical snapshot identity into the review handoff", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "stage-handoff-"));
    temporaryDirectories.push(repositoryRoot);
    await executeFile("git", ["init", "--quiet"], { cwd: repositoryRoot });
    await mkdir(join(repositoryRoot, "blueprints"));
    const blueprintPath = await writeDeliveryBlueprintFixture(
      repositoryRoot,
      "standard-delivery",
    );
    const blueprint = JSON.parse(
      await readFile(join(repositoryRoot, blueprintPath), "utf8"),
    ) as {
      nodes: Array<{
        "assign-agent-name"?: string;
        id: string;
        skills?: string[];
      }>;
    };
    const reviewNode = blueprint.nodes.find(({ id }) => id === "review")!;
    reviewNode.skills = ["evidence-review"];
    reviewNode["assign-agent-name"] = "antagonists";
    await writeFile(
      join(repositoryRoot, blueprintPath),
      `${JSON.stringify(blueprint, null, 2)}\n`,
    );
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
      kind: "stage",
      activation: 1,
      binding: binding(sessionKey, "sample-thread"),
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

    expect(review).toMatchObject({
      agentNameList: "antagonists",
      handoff: {
        kind: "standard",
        name: "review",
        priorStageOutputs: [
          { result: "ready" },
          { snapshotId: "snapshot-sample" },
        ],
        skills: ["evidence-review"],
      },
    });
    persistence.close();
  });

  it("hands a stage the output of the node that routed into it", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "stage-handoff-"));
    temporaryDirectories.push(repositoryRoot);
    await executeFile("git", ["init", "--quiet"], { cwd: repositoryRoot });
    await mkdir(join(repositoryRoot, "blueprints"));
    await writeDeliveryBlueprintFixture(repositoryRoot, "standard-delivery");
    const persistence = new SqlitePersistence({
      stateDirectory: join(repositoryRoot, "state"),
    });
    let mergeActivation = 0;
    const engine = new LifecycleEngine({
      effects: {
        finalize: async () => ({}),
        merge: async () => {
          mergeActivation += 1;
          return mergeActivation === 1
            ? {
                alreadyMerged: false,
                dispositions: { merged: false, remediate: true },
                merged: false,
                remediationCause: driftCause,
                snapshotId: driftCause.snapshotId,
              }
            : {
                alreadyMerged: false,
                dispositions: { merged: true },
                merged: true,
              };
        },
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
    const recordSession = (stageId: string, activation: number): string => {
      const sessionKey = `${instanceId}:${stageId}:${activation}`;
      persistence.writeSessionRuntime({
        kind: "stage",
        activation,
        binding: binding(sessionKey, `${stageId}-thread-${activation}`),
        instanceId,
        sessionKey,
        stageId,
        threadId: `${stageId}-thread-${activation}`,
      });
      return sessionKey;
    };
    await engine.resume({
      disposition: "complete",
      instanceId,
      operationId: advanceOperationId(recordSession("implement", 1)),
    });
    const findings = [{ code: "P1", summary: "A recorded value is unchecked" }];
    await engine.resume({
      disposition: "reject",
      instanceId,
      operationId: advanceOperationId(recordSession("review", 1)),
      output: { findings, transcript: ["private review discussion"] },
    });
    recordSession("remediate", 1);

    // Routed from the review stage: the entry is the reviewer's own output.
    await expect(
      readProductionHandoffStage({
        instanceId,
        persistence,
        repositoryRoot,
        stageId: "remediate",
      }),
    ).resolves.toMatchObject({
      handoff: {
        entry: {
          node: "review",
          output: {
            disposition: "reject",
            dispositions: { reject: true },
            findings,
            transcript: ["private review discussion"],
          },
        },
        kind: "remediation",
        name: "remediate",
      },
    });

    await engine.resume({
      disposition: "complete",
      instanceId,
      operationId: advanceOperationId(`${instanceId}:remediate:1`),
    });
    await engine.resume({
      disposition: "approve",
      instanceId,
      operationId: advanceOperationId(recordSession("review", 2)),
    });
    recordSession("remediate", 2);

    // Routed from the merge node: the entry is the merge output with its cause.
    await expect(
      readProductionHandoffStage({
        instanceId,
        persistence,
        repositoryRoot,
        stageId: "remediate",
      }),
    ).resolves.toMatchObject({
      handoff: {
        entry: {
          node: "merge",
          output: { merged: false, remediationCause: driftCause },
        },
        kind: "remediation",
      },
    });
    persistence.close();
  });
});
