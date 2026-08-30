// ---
// relationships:
//   verifies: heddle
// ---

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsoleLifecycleUnavailableError } from "../console/index.js";
import { readLifecycleContext } from "../engine/index.js";
import { advanceOperationId } from "../mcp-server/operations.js";
import { createProductionComposition } from "./composition.js";
import {
  prepareProductionFixture,
  SyntheticT3,
} from "./composition.test-support.js";

describe("production console lifecycle source", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
  });

  it("reads pinned blueprint and Task-683-ordered history through one cursor", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const { blueprintsRepositoryRoot, configuration, taskId } = fixture;
    const composition = createProductionComposition({
      blueprintsRepositoryRoot,
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    });
    await composition.start();

    const initial = await composition.consoleState.readLifecycle({
      afterSequence: 0,
      taskId,
    });
    expect(initial).toMatchObject({
      currentStageIds: ["implement"],
      instanceId: `task-${taskId}`,
      status: "awaiting",
      taskId,
    });
    expect(initial.blueprint).toMatchObject({
      id: "sample",
      path: "blueprints/sample.json",
    });
    expect(initial.blueprint.blobHash).toMatch(/^[0-9a-f]{40}$/);
    expect(initial.blueprint.nodes.map(({ id }) => id)).toContain("implement");
    expect(initial.events.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: initial.nextSequence }, (_, index) => index + 1),
    );

    const blueprintPath = join(
      blueprintsRepositoryRoot,
      "blueprints/sample.json",
    );
    const workingBlueprint = JSON.parse(
      await readFile(blueprintPath, "utf8"),
    ) as Record<string, unknown>;
    await writeFile(
      blueprintPath,
      JSON.stringify({ ...workingBlueprint, nodes: [{ id: "changed" }] }),
    );
    const stillPinned = await composition.consoleState.readLifecycle({
      afterSequence: 0,
      taskId,
    });
    expect(stillPinned.blueprint).toEqual(initial.blueprint);

    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId: `task-${taskId}`,
      operationId: advanceOperationId(`task-${taskId}:implement:1`),
      output: { result: { count: 2 } },
    });
    await composition.scheduler.trigger();
    const tail = await composition.consoleState.readLifecycle({
      afterSequence: initial.nextSequence,
      taskId,
    });
    expect(tail).toMatchObject({
      blueprint: initial.blueprint,
      currentStageIds: ["review"],
      instanceId: initial.instanceId,
      status: "awaiting",
      taskId,
    });
    expect(tail.nextSequence).toBeGreaterThan(initial.nextSequence);
    expect(tail.events[0]?.sequence).toBe(initial.nextSequence + 1);
    expect(tail.events.at(-1)?.sequence).toBe(tail.nextSequence);

    const context = readLifecycleContext(
      composition.persistence.getInstance(`task-${taskId}`)!,
    );
    const executionIds = [
      ...new Set(
        [...initial.events, ...tail.events].map(
          ({ executionId }) => executionId,
        ),
      ),
    ];
    expect(executionIds).toEqual(context.executionIds);
    await composition.close();
  });

  it("reports an unavailable task without synthesizing lifecycle identity", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const composition = createProductionComposition({
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    });

    await expect(
      composition.consoleState.readLifecycle({
        afterSequence: 0,
        taskId: fixture.taskId,
      }),
    ).rejects.toBeInstanceOf(ConsoleLifecycleUnavailableError);
    await composition.close();
  });
});
