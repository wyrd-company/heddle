// ---
// relationships:
//   verifies: heddle
// ---

import { afterEach, describe, expect, it } from "vitest";

import type { LifecycleBlueprint, LifecycleEffect } from "./index.js";
import {
  cleanupFixtures,
  conditionalTerminalBlueprint,
  makeFixture,
  sampleBlueprint,
} from "./lifecycle-engine.test-support.js";

const serializedContextFrom = (value: unknown): string => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("serializedContext" in value) ||
    typeof value.serializedContext !== "string"
  ) {
    throw new Error("Serialized lifecycle context is missing");
  }
  return value.serializedContext;
};

afterEach(async () => {
  await cleanupFixtures();
});

describe("LifecycleEngine concurrent execution", () => {
  it("rejects a landing with multiple wait nodes", async () => {
    const blueprint: LifecycleBlueprint = {
      id: "parallel-sample",
      nodes: [
        { id: "select", uses: "select" },
        { id: "left", uses: "wait" },
        { id: "right", uses: "wait" },
        { id: "left-done", uses: "finish" },
        { id: "right-done", uses: "finish" },
      ],
      edges: [
        { source: "select", target: "left", condition: "result.output.left" },
        {
          source: "select",
          target: "right",
          condition: "result.output.right",
        },
        {
          source: "left",
          target: "left-done",
          disposition: "continue",
          condition: "result.output.dispositions.continue",
        },
        {
          source: "right",
          target: "right-done",
          disposition: "continue",
          condition: "result.output.dispositions.continue",
        },
      ],
    };
    const fixture = await makeFixture(blueprint, {
      finish: async () => ({ complete: true }),
      select: async () => ({ left: true, right: true }),
    });

    await expect(
      fixture.engine.start({
        blueprintPath: fixture.blueprintPath,
        instanceId: "sample-a",
      }),
    ).rejects.toThrow(/more than one wait node/);
    fixture.persistence.close();
  });

  it("rejects expected landing expansion beyond the supported limit", async () => {
    const optionIds = Array.from(
      { length: 9 },
      (_, index) => `option-${index}`,
    );
    const blueprint: LifecycleBlueprint = {
      id: "wide-sample",
      nodes: [
        { id: "select", uses: "select" },
        ...optionIds.map((id) => ({ id, uses: "finish" })),
      ],
      edges: optionIds.map((target, index) => ({
        source: "select",
        target,
        condition: `result.output.option${index}`,
      })),
    };
    const fixture = await makeFixture(blueprint, {
      finish: async () => ({ complete: true }),
      select: async () =>
        Object.fromEntries(
          optionIds.map((_, index) => [`option${index}`, true]),
        ),
    });

    await expect(
      fixture.engine.start({
        blueprintPath: fixture.blueprintPath,
        instanceId: "sample-a",
      }),
    ).rejects.toThrow(/more than 255 expected landing alternatives/);
    fixture.persistence.close();
  });

  it("merges overlapping retries of the same pending disposition", async () => {
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
        return { attempt: attempts };
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
    });
    await firstStarted;
    const second = await fixture.engine.resume({
      disposition: "adjust",
      instanceId: "sample-a",
      operationId: "operation-a",
    });
    const completed = await fixture.engine.resume({
      disposition: "accept",
      instanceId: "sample-a",
      operationId: "operation-b",
    });
    const beforeLateCompletion =
      fixture.persistence.getInstance("sample-a")?.state.flowcraftContext;
    releaseFirst?.();
    const late = await first;
    const persisted =
      fixture.persistence.getInstance("sample-a")?.state.flowcraftContext;
    const laterExecutionIds = completed.executionIds.filter(
      (executionId) => !second.executionIds.includes(executionId),
    );

    expect(second.executionIds).toHaveLength(2);
    expect(late.executionIds).toHaveLength(3);
    expect(late).toMatchObject({
      awaitingNodeIds: ["taste"],
      status: "awaiting",
      validDispositions: ["accept", "adjust"],
    });
    expect(laterExecutionIds).toHaveLength(1);
    expect(late.executionIds).not.toContain(laterExecutionIds[0]);
    expect(persisted).toMatchObject({
      awaitingNodeIds: [],
      executionIds: expect.arrayContaining([
        ...completed.executionIds,
        ...late.executionIds,
      ]),
      pendingTransition: null,
      serializedContext: serializedContextFrom(beforeLateCompletion),
      status: "completed",
    });
    fixture.persistence.close();
  });

  it("returns the committed operation after a stale execution diverges", async () => {
    const blueprint = sampleBlueprint();
    const loopEdge = blueprint.edges.find(
      ({ source, target }) => source === "season" && target === "taste",
    );
    if (loopEdge === undefined) throw new Error("Fixture loop edge is missing");
    loopEdge.condition = "result.output.ready";
    let attempts = 0;
    let releaseFirst: (() => void) | undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const fixture = await makeFixture(blueprint, {
      mix: async () => ({ effect: "mix" }),
      season: async () => {
        attempts += 1;
        if (attempts === 1) {
          markFirstStarted?.();
          await firstMayFinish;
          return { ready: false };
        }
        return { ready: true };
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
    });
    await firstStarted;
    const committed = await fixture.engine.resume({
      disposition: "adjust",
      instanceId: "sample-a",
      operationId: "operation-a",
    });
    const completed = await fixture.engine.resume({
      disposition: "accept",
      instanceId: "sample-a",
      operationId: "operation-b",
    });
    const beforeLateCompletion =
      fixture.persistence.getInstance("sample-a")?.state.flowcraftContext;
    releaseFirst?.();
    const late = await first;
    const persisted = fixture.persistence.getInstance("sample-a");
    const laterExecutionIds = completed.executionIds.filter(
      (executionId) => !committed.executionIds.includes(executionId),
    );

    expect(late).toMatchObject({
      awaitingNodeIds: ["taste"],
      status: "awaiting",
      validDispositions: ["accept", "adjust"],
    });
    expect(late.executionIds).toEqual(
      expect.arrayContaining(committed.executionIds),
    );
    expect(late.executionIds).toHaveLength(committed.executionIds.length + 1);
    expect(laterExecutionIds).toHaveLength(1);
    expect(late.executionIds).not.toContain(laterExecutionIds[0]);
    expect(persisted?.state.flowcraftContext).toMatchObject({
      awaitingNodeIds: [],
      executionIds: expect.arrayContaining([
        ...completed.executionIds,
        ...late.executionIds,
      ]),
      serializedContext: serializedContextFrom(beforeLateCompletion),
      status: "completed",
    });
    expect(completed.status).toBe("completed");
    expect(
      fixture.persistence
        .replayEvents("sample-a")
        .filter(({ type }) => type === "lifecycle:attention-required"),
    ).toEqual([]);
    fixture.persistence.close();
  });

  it("accepts the selected terminal from mutually exclusive conditions", async () => {
    const blueprint = conditionalTerminalBlueprint();
    const applied: string[] = [];
    const record =
      (effect: string, output: Record<string, boolean> = {}): LifecycleEffect =>
      async () => {
        applied.push(effect);
        return { effect, ...output };
      };
    const fixture = await makeFixture(blueprint, {
      choose: record("choose", { left: true, right: false }),
      left: record("left"),
      mix: record("mix"),
      right: record("right"),
      season: record("season"),
      serve: record("serve"),
    });
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "sample-a",
    });

    const completed = await fixture.engine.resume({
      disposition: "accept",
      instanceId: "sample-a",
      operationId: "operation-a",
    });

    expect(completed.status).toBe("completed");
    expect(applied).toEqual(["mix", "choose", "left"]);
    fixture.persistence.close();
  });

  it("accepts every terminal selected by true conditions", async () => {
    const applied: string[] = [];
    const record =
      (effect: string, output: Record<string, boolean> = {}): LifecycleEffect =>
      async () => {
        applied.push(effect);
        return { effect, ...output };
      };
    const fixture = await makeFixture(conditionalTerminalBlueprint(), {
      choose: record("choose", { left: true, right: true }),
      left: record("left"),
      mix: record("mix"),
      right: record("right"),
      season: record("season"),
    });
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "sample-a",
    });

    const completed = await fixture.engine.resume({
      disposition: "accept",
      instanceId: "sample-a",
      operationId: "operation-a",
    });

    expect(completed.status).toBe("completed");
    expect(applied).toHaveLength(4);
    expect(applied).toEqual(
      expect.arrayContaining(["mix", "choose", "left", "right"]),
    );
    fixture.persistence.close();
  });
});
