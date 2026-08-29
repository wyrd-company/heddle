// ---
// relationships:
//   verifies: heddle
// ---

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TransitionConflictError, type LifecycleBlueprint } from "./index.js";
import {
  cleanupFixtures,
  makeFixture,
  sampleBlueprint,
} from "./lifecycle-engine.test-support.js";

afterEach(async () => {
  await cleanupFixtures();
});

describe("LifecycleEngine identity", () => {
  it("returns the committed result when a completed resume is retried", async () => {
    const fixture = await makeFixture();
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "sample-a",
    });
    await expect(
      fixture.engine.resume({
        disposition: "adjust",
        instanceId: "sample-a",
        operationId: " ",
      }),
    ).rejects.toThrow(/operation ID must not be empty/);
    const request = {
      disposition: "adjust",
      instanceId: "sample-a",
      operationId: "operation-a",
      output: { first: 1, second: 2 },
    };

    const completed = await fixture.engine.resume(request);
    const retried = await fixture.engine.resume({
      ...request,
      output: { second: 2, first: 1 },
    });
    await fixture.engine.resume({
      disposition: "accept",
      instanceId: "sample-a",
      operationId: "operation-b",
    });
    const delayedRetry = await fixture.engine.resume(request);

    expect(retried).toEqual(completed);
    expect(delayedRetry).toEqual(completed);
    expect(
      fixture.invocations.filter(({ effect }) => effect === "season"),
    ).toHaveLength(1);
    await expect(
      fixture.engine.resume({
        ...request,
        output: { first: 1, second: 3 },
      }),
    ).rejects.toEqual(new TransitionConflictError("sample-a"));
    fixture.persistence.close();
  });

  it("returns the committed result for a prototype-named operation", async () => {
    const fixture = await makeFixture();
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "sample-a",
    });
    const request = {
      disposition: "adjust",
      instanceId: "sample-a",
      operationId: "__proto__",
    };

    const completed = await fixture.engine.resume(request);
    const retried = await fixture.engine.resume(request);

    expect(retried).toEqual(completed);
    expect(
      fixture.invocations.filter(({ effect }) => effect === "season"),
    ).toHaveLength(1);
    fixture.persistence.close();
  });

  it("rejects a different operation while an equivalent resume is pending", async () => {
    let attempts = 0;
    let releaseFirst: (() => void) | undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const fixture = await makeFixture(sampleBlueprint(), {
      mix: async () => ({ effect: "mix" }),
      season: async () => {
        attempts += 1;
        if (attempts === 1) {
          markFirstStarted?.();
          await firstMayFinish;
        }
        return { effect: "season" };
      },
      serve: async () => ({ effect: "serve" }),
    });
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "sample-a",
    });

    const first = fixture.engine.resume({
      disposition: "adjust",
      instanceId: "sample-a",
      operationId: "operation-a",
      output: { value: 1 },
    });
    await firstStarted;
    await expect(
      fixture.engine.resume({
        disposition: "adjust",
        instanceId: "sample-a",
        operationId: "operation-b",
        output: { value: 1 },
      }),
    ).rejects.toEqual(new TransitionConflictError("sample-a"));
    await expect(
      fixture.engine.resume({
        disposition: "adjust",
        instanceId: "sample-a",
        operationId: "operation-a",
        output: { value: 2 },
      }),
    ).rejects.toEqual(new TransitionConflictError("sample-a"));
    releaseFirst?.();
    await first;
    fixture.persistence.close();
  });

  it("rejects malformed completed-operation state", async () => {
    const fixture = await makeFixture();
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "sample-a",
    });
    const record = fixture.persistence.getInstance("sample-a");
    if (record === undefined) throw new Error("Fixture instance is missing");
    const context = record.state.flowcraftContext;
    if (context === null || Array.isArray(context)) {
      throw new Error("Fixture lifecycle context is malformed");
    }
    fixture.persistence.updateInstance("sample-a", {
      ...record.state,
      flowcraftContext: { ...context, completedOperations: [] },
    });

    await expect(
      fixture.engine.resume({
        disposition: "adjust",
        instanceId: "sample-a",
        operationId: "operation-a",
      }),
    ).rejects.toThrow(/does not contain lifecycle engine state/);
    fixture.persistence.close();
  });

  it("encodes effect identity tuples without collisions", async () => {
    const keys: string[] = [];
    const firstBlueprint: LifecycleBlueprint = {
      id: "first-sample",
      nodes: [{ id: "b:1:c", uses: "record" }],
      edges: [],
    };
    const secondBlueprint: LifecycleBlueprint = {
      id: "second-sample",
      nodes: [{ id: "c", uses: "record" }],
      edges: [],
    };
    const fixture = await makeFixture(firstBlueprint, {
      record: async ({ idempotencyKey }) => {
        keys.push(idempotencyKey);
        return { complete: true };
      },
    });
    const secondPath = "blueprints/second.json";
    await writeFile(
      join(fixture.repositoryRoot, secondPath),
      JSON.stringify(secondBlueprint),
    );

    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "a",
    });
    await fixture.engine.start({
      blueprintPath: secondPath,
      instanceId: "a:1:b",
    });

    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    fixture.persistence.close();
  });

  it("rejects duplicate blueprint node IDs before execution", async () => {
    const applied: string[] = [];
    const blueprint = sampleBlueprint();
    blueprint.nodes = [
      { id: "same", uses: "left" },
      { id: "same", uses: "right" },
    ];
    blueprint.edges = [];
    const fixture = await makeFixture(blueprint, {
      left: async () => {
        applied.push("left");
        return { complete: true };
      },
      right: async () => {
        applied.push("right");
        return { complete: true };
      },
    });

    await expect(
      fixture.engine.start({
        blueprintPath: fixture.blueprintPath,
        instanceId: "sample-a",
      }),
    ).rejects.toThrow(/duplicate node ID/);
    expect(applied).toEqual([]);
    fixture.persistence.close();
  });
});
