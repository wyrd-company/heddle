// ---
// relationships:
//   verifies: heddle
// ---

import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqlitePersistence } from "../persistence/index.js";
import { LifecycleEngine } from "./lifecycle-engine.js";
import {
  cleanupFixtures,
  makeFixture,
  sampleBlueprint,
} from "./lifecycle-engine.test-support.js";
import type { LifecycleEffect } from "./types.js";

afterEach(async () => {
  await cleanupFixtures();
});

const prepareDivergentLateExecution = async () => {
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
  const effects: Record<string, LifecycleEffect> = {
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
  };
  const fixture = await makeFixture(blueprint, effects);
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
  await fixture.engine.resume({
    disposition: "accept",
    instanceId: "sample-a",
    operationId: "operation-b",
  });
  return { committed, effects, first, fixture, releaseFirst };
};

const recoverOperation = async (
  repositoryRoot: string,
  effects: Record<string, LifecycleEffect>,
) => {
  const persistence = new SqlitePersistence({
    stateDirectory: join(repositoryRoot, "state"),
  });
  const engine = new LifecycleEngine({ effects, persistence, repositoryRoot });
  const snapshot = await engine.resume({
    disposition: "adjust",
    instanceId: "sample-a",
    operationId: "operation-a",
  });
  return { persistence, snapshot };
};

const attentionEventsFrom = (persistence: SqlitePersistence) =>
  persistence
    .replayEvents("sample-a")
    .filter(({ type }) => type === "lifecycle:attention-required");

describe("LifecycleEngine attention recovery", () => {
  it("recovers attention after its first append fails", async () => {
    const { committed, effects, first, fixture, releaseFirst } =
      await prepareDivergentLateExecution();
    const appendEvent = fixture.persistence.appendEvent.bind(
      fixture.persistence,
    );
    let rejectAttention = true;
    fixture.persistence.appendEvent = (instanceId, type, payload) => {
      if (type === "lifecycle:attention-required" && rejectAttention) {
        rejectAttention = false;
        throw new Error("Injected attention append failure");
      }
      return appendEvent(instanceId, type, payload);
    };

    releaseFirst?.();
    await expect(first).rejects.toThrow("Injected attention append failure");
    expect(attentionEventsFrom(fixture.persistence)).toHaveLength(0);
    expect(
      fixture.persistence.getInstance("sample-a")?.state.flowcraftContext,
    ).toMatchObject({
      pendingAttentions: [
        {
          actualStatus: "completed",
          transitionId: "sample-a:2",
        },
      ],
    });
    fixture.persistence.close();

    const recovered = await recoverOperation(fixture.repositoryRoot, effects);

    expect(recovered.snapshot).toMatchObject({
      awaitingNodeIds: ["taste"],
      executionIds: expect.arrayContaining(committed.executionIds),
      status: "awaiting",
    });
    const attentionEvents = attentionEventsFrom(recovered.persistence);
    expect(attentionEvents).toHaveLength(1);
    expect(attentionEvents[0]?.payload).toMatchObject({
      actualAwaitingNodeIds: [],
      actualStatus: "completed",
      expectedAwaitingNodeIds: ["taste"],
      transitionId: "sample-a:2",
    });
    expect(
      recovered.persistence.getInstance("sample-a")?.state.flowcraftContext,
    ).toMatchObject({ pendingAttentions: [] });
    recovered.persistence.close();
  });

  it("does not duplicate attention after append succeeds before marker clear", async () => {
    const { effects, first, fixture, releaseFirst } =
      await prepareDivergentLateExecution();
    const compareAndSwap = fixture.persistence.compareAndSwapInstance.bind(
      fixture.persistence,
    );
    let rejectMarkerClear = true;
    fixture.persistence.compareAndSwapInstance = (
      instanceId,
      expectedVersion,
      state,
    ) => {
      if (
        rejectMarkerClear &&
        attentionEventsFrom(fixture.persistence).length > 0
      ) {
        rejectMarkerClear = false;
        throw new Error("Injected attention marker clear failure");
      }
      return compareAndSwap(instanceId, expectedVersion, state);
    };

    releaseFirst?.();
    await expect(first).rejects.toThrow(
      "Injected attention marker clear failure",
    );
    expect(attentionEventsFrom(fixture.persistence)).toHaveLength(1);
    expect(
      fixture.persistence.getInstance("sample-a")?.state.flowcraftContext,
    ).toMatchObject({ pendingAttentions: [expect.any(Object)] });
    fixture.persistence.close();

    const recovered = await recoverOperation(fixture.repositoryRoot, effects);

    expect(recovered.snapshot).toMatchObject({
      awaitingNodeIds: ["taste"],
      status: "awaiting",
    });
    expect(attentionEventsFrom(recovered.persistence)).toHaveLength(1);
    expect(
      recovered.persistence.getInstance("sample-a")?.state.flowcraftContext,
    ).toMatchObject({ pendingAttentions: [] });
    recovered.persistence.close();
  });
});
