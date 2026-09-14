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
