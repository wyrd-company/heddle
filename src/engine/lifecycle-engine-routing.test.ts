// ---
// relationships:
//   verifies: heddle
// ---

import { afterEach, describe, expect, it } from "vitest";

import {
  UnexpectedLandingError,
  type LifecycleBlueprint,
  type LifecycleEffect,
} from "./index.js";
import {
  cleanupFixtures,
  makeFixture,
} from "./lifecycle-engine.test-support.js";

afterEach(async () => {
  await cleanupFixtures();
});

const nestedBlueprint = (): LifecycleBlueprint => ({
  id: "nested-sample",
  nodes: [
    { id: "prepare", uses: "prepare" },
    { id: "choose", uses: "choose" },
    { id: "left", uses: "left" },
    { id: "gate", uses: "gate" },
    { id: "right", uses: "right" },
  ],
  edges: [
    { source: "prepare", target: "choose" },
    { source: "choose", target: "left", condition: "result.output.left" },
    { source: "choose", target: "gate", condition: "result.output.right" },
    { source: "gate", target: "right", condition: "result.output.finish" },
  ],
});

const makeNestedFixture = async (finish: boolean) => {
  const applied: string[] = [];
  const record =
    (effect: string, output: Record<string, boolean> = {}): LifecycleEffect =>
    async () => {
      applied.push(effect);
      return output;
    };
  const fixture = await makeFixture(nestedBlueprint(), {
    choose: record("choose", { left: true, right: true }),
    gate: record("gate", { finish }),
    left: record("left"),
    prepare: record("prepare"),
    right: record("right"),
  });
  return { applied, fixture };
};

describe("LifecycleEngine conditional routing", () => {
  it("rejects a completed nested branch that matched no landing", async () => {
    const { applied, fixture } = await makeNestedFixture(false);

    await expect(
      fixture.engine.start({
        blueprintPath: fixture.blueprintPath,
        instanceId: "sample-a",
      }),
    ).rejects.toThrow(UnexpectedLandingError);
    expect(applied).toHaveLength(4);
    expect(applied).toEqual(
      expect.arrayContaining(["prepare", "choose", "left", "gate"]),
    );
    expect(applied).not.toContain("right");
    expect(
      fixture.persistence
        .replayEvents("sample-a")
        .filter(({ type }) => type === "lifecycle:attention-required"),
    ).toHaveLength(1);
    fixture.persistence.close();
  });

  it("accepts a nested route when every selected branch lands", async () => {
    const { applied, fixture } = await makeNestedFixture(true);

    const completed = await fixture.engine.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "sample-a",
    });

    expect(completed.status).toBe("completed");
    expect(applied).toHaveLength(5);
    expect(applied).toEqual(
      expect.arrayContaining(["prepare", "choose", "left", "gate", "right"]),
    );
    expect(
      fixture.persistence
        .replayEvents("sample-a")
        .filter(({ type }) => type === "lifecycle:attention-required"),
    ).toEqual([]);
    fixture.persistence.close();
  });
});
