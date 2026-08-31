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
});
