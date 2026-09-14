// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readLifecycleContext } from "../engine/index.js";
import { advanceOperationId } from "../mcp-server/operations.js";
import { createProductionComposition } from "./composition.js";
import {
  prepareProductionFixture,
  SyntheticT3,
  type ProductionFixture,
} from "./composition.test-support.js";

const execute = promisify(execFile);
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

/** begin → implement → stop (fail) with a message rendered from the graph. */
const installFailingBlueprint = async (
  fixture: ProductionFixture,
): Promise<void> => {
  const path = join(
    fixture.blueprintsRepositoryRoot,
    "blueprints",
    "sample.json",
  );
  const blueprint = JSON.parse(await readFile(path, "utf8")) as {
    edges: unknown[];
    nodes: Array<Record<string, unknown>>;
  };
  const implement = blueprint.nodes.find(({ id }) => id === "implement")!;
  blueprint.nodes = [
    { id: "begin", uses: "complete" },
    implement,
    {
      id: "stop",
      params: {
        message:
          "Task {{ task.id }} stopped after {{ lifecycle.current.node }}: {{ lifecycle.outputs.implement.reason }}",
      },
      uses: "fail",
    },
  ];
  blueprint.edges = [
    { source: "begin", target: "implement" },
    {
      condition: "result.output.dispositions.complete",
      description: "Complete the sample",
      disposition: "complete",
      source: "implement",
      target: "stop",
    },
  ];
  await writeFile(path, `${JSON.stringify(blueprint, null, 2)}\n`);
  await execute("git", ["add", "blueprints/sample.json"], {
    cwd: fixture.blueprintsRepositoryRoot,
  });
  await execute(
    "git",
    [
      "-c",
      "user.name=Fixture User",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Stop after implementation",
    ],
    { cwd: fixture.blueprintsRepositoryRoot },
  );
  await execute("git", ["push", "--quiet"], {
    cwd: fixture.blueprintsRepositoryRoot,
  });
};

describe("production fail primitive", () => {
  it("ends the lifecycle with rendered attention and leaves the task where it was", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    await installFailingBlueprint(fixture);
    const composition = createProductionComposition({
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
    });
    const instanceId = `task-${fixture.taskId}`;
    await composition.start();
    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId,
      operationId: advanceOperationId(`${instanceId}:implement:1`),
      output: { reason: "the sample did not fit" },
    });
    await composition.scheduler.trigger();

    expect(
      readLifecycleContext(composition.persistence.getInstance(instanceId)!),
    ).toMatchObject({ awaitingNodeIds: [], status: "completed" });
    expect(composition.attention.list()).toEqual([
      expect.objectContaining({
        attentionId: `lifecycle:failed:${instanceId}:stop:1`,
        kind: "production-error",
        instanceId,
        message: `Task ${fixture.taskId} stopped after implement: the sample did not fit`,
        taskId: fixture.taskId,
      }),
    ]);
    const runtime = composition.persistence
      .listReconcilerRuntime()
      .find((candidate) => candidate.instanceId === instanceId);
    expect(runtime).toMatchObject({
      boardStatus: "in-progress",
      state: "done",
    });
    expect((await composition.board.readTask(fixture.taskId)).status).toBe(
      "in-progress",
    );
    await composition.close();
  });
});
