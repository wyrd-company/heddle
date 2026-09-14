// ---
// relationships:
//   verifies: heddle
// ---

import { afterEach, describe, expect, it } from "vitest";

import { SqlitePersistence } from "../persistence/index.js";
import { LifecycleEngine } from "./lifecycle-engine.js";
import {
  cleanupFixtures,
  makeFixture,
  sampleBlueprint,
} from "./lifecycle-engine.test-support.js";
import { lifecycleProjectionOf } from "./lifecycle-projection.js";
import { readLifecycleContext } from "./lifecycle-state.js";
import type { LifecycleBlueprint } from "./types.js";

const projection = (persistence: SqlitePersistence, instanceId: string) => {
  const record = persistence.getInstance(instanceId);
  if (record === undefined) throw new Error("instance is missing");
  return lifecycleProjectionOf(readLifecycleContext(record));
};

/** `adjust` loops until the wait node has been visited `limit` times. */
const boundedAdjust = (): LifecycleBlueprint => {
  const blueprint = sampleBlueprint();
  blueprint.metadata = { limit: 3 };
  const adjust = blueprint.edges.find(
    ({ disposition }) => disposition === "adjust",
  );
  if (adjust === undefined) throw new Error("adjust edge is missing");
  adjust.condition =
    "result.output.dispositions.adjust and lifecycle.visits.taste < lifecycle.blueprint.metadata.limit";
  blueprint.edges.push({
    ...adjust,
    condition:
      "result.output.dispositions.adjust and lifecycle.visits.taste >= lifecycle.blueprint.metadata.limit",
    target: "serve",
  });
  return blueprint;
};

describe("lifecycle projection", () => {
  afterEach(cleanupFixtures);

  it("publishes outputs, visits, the current node, task, and metadata", async () => {
    const blueprint = sampleBlueprint();
    blueprint.metadata = { limit: 3 };
    const fixture = await makeFixture(blueprint);
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      initialContext: { taskContract: { id: 17, title: "Sample" } },
      instanceId: "projected",
    });
    expect(projection(fixture.persistence, "projected")).toEqual({
      blueprint: { metadata: { limit: 3 } },
      current: { node: "mix", visit: 1 },
      outputs: { mix: { effect: "mix" } },
      task: { id: 17, title: "Sample" },
      visits: { mix: 1 },
    });

    for (const round of [1, 2]) {
      await fixture.engine.resume({
        disposition: "adjust",
        instanceId: "projected",
        operationId: `round-${round}`,
        output: { round },
      });
    }
    expect(projection(fixture.persistence, "projected")).toMatchObject({
      current: { node: "season", visit: 2 },
      outputs: {
        season: { effect: "season" },
        taste: {
          disposition: "adjust",
          dispositions: { adjust: true },
          round: 2,
        },
      },
      visits: { mix: 1, season: 2, taste: 2 },
    });
    fixture.persistence.close();
  });

  it("lets a guard bound a loop on visits and blueprint metadata", async () => {
    const fixture = await makeFixture(boundedAdjust());
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "bounded",
    });
    for (const round of [1, 2]) {
      const snapshot = await fixture.engine.resume({
        disposition: "adjust",
        instanceId: "bounded",
        operationId: `round-${round}`,
      });
      expect(snapshot).toMatchObject({ awaitingNodeIds: ["taste"] });
    }
    const completed = await fixture.engine.resume({
      disposition: "adjust",
      instanceId: "bounded",
      operationId: "round-3",
    });
    expect(completed).toMatchObject({
      awaitingNodeIds: [],
      status: "completed",
    });
    expect(fixture.invocations.map(({ effect }) => effect)).toEqual([
      "mix",
      "season",
      "season",
      "serve",
    ]);
    fixture.persistence.close();
  });

  it("keeps visits across a restart of the engine", async () => {
    const fixture = await makeFixture(boundedAdjust());
    await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "restarted",
    });
    for (const round of [1, 2]) {
      await fixture.engine.resume({
        disposition: "adjust",
        instanceId: "restarted",
        operationId: `round-${round}`,
      });
    }
    fixture.persistence.close();

    const persistence = new SqlitePersistence({
      stateDirectory: `${fixture.repositoryRoot}/state`,
    });
    const served: string[] = [];
    const engine = new LifecycleEngine({
      effects: {
        mix: async () => ({ effect: "mix" }),
        season: async () => ({ effect: "season" }),
        serve: async () => {
          served.push("serve");
          return { effect: "serve" };
        },
      },
      persistence,
      repositoryRoot: fixture.repositoryRoot,
    });
    expect(projection(persistence, "restarted").visits).toEqual({
      mix: 1,
      season: 2,
      taste: 2,
    });
    const completed = await engine.resume({
      disposition: "adjust",
      instanceId: "restarted",
      operationId: "round-3",
    });
    expect(completed).toMatchObject({ status: "completed" });
    expect(served).toEqual(["serve"]);
    persistence.close();
  });
});

/** A mechanical fan-out: mix runs whisk and knead in parallel, each to its own terminal. */
const fanOutBlueprint = (condition?: string): LifecycleBlueprint => ({
  id: "fan-out",
  nodes: [
    { id: "mix", uses: "mix" },
    { id: "whisk", uses: "whisk" },
    { id: "knead", uses: "knead" },
    { id: "bake", uses: "bake" },
    { id: "proof", uses: "proof" },
  ],
  edges: [
    { source: "mix", target: "whisk", ...(condition ? { condition } : {}) },
    { source: "mix", target: "knead", ...(condition ? { condition } : {}) },
    { source: "whisk", target: "bake" },
    { source: "knead", target: "proof" },
  ],
});

const fanOutEffects = () =>
  Object.fromEntries(
    ["mix", "whisk", "knead", "bake", "proof"].map((name) => [
      name,
      async () => ({ effect: name }),
    ]),
  );

describe("lifecycle projection under fan-out", () => {
  afterEach(cleanupFixtures);

  it("keeps every parallel branch in visits and outputs", async () => {
    const fixture = await makeFixture(fanOutBlueprint(), fanOutEffects());
    const snapshot = await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "fan-out",
    });
    expect(snapshot).toMatchObject({ status: "completed" });
    const projected = projection(fixture.persistence, "fan-out");
    expect(projected.visits).toEqual({
      bake: 1,
      knead: 1,
      mix: 1,
      proof: 1,
      whisk: 1,
    });
    expect(Object.keys(projected.outputs).sort()).toEqual([
      "bake",
      "knead",
      "mix",
      "proof",
      "whisk",
    ]);
    fixture.persistence.close();
  });

  it("routes every guarded parallel branch to its terminal", async () => {
    const fixture = await makeFixture(fanOutBlueprint("true"), fanOutEffects());
    const snapshot = await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "guarded-fan-out",
    });
    expect(snapshot).toMatchObject({
      awaitingNodeIds: [],
      status: "completed",
    });
    expect(
      fixture.persistence
        .replayEvents("guarded-fan-out")
        .filter(({ type }) => type === "lifecycle:attention-required"),
    ).toHaveLength(0);
    expect(projection(fixture.persistence, "guarded-fan-out").visits).toEqual({
      bake: 1,
      knead: 1,
      mix: 1,
      proof: 1,
      whisk: 1,
    });
    fixture.persistence.close();
  });
});
