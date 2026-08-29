// ---
// relationships:
//   verifies: heddle
// ---

import { afterEach, describe, expect, it } from "vitest";

import type { LifecycleEffect } from "./index.js";
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
    });
    await firstStarted;
    const second = await fixture.engine.resume({
      disposition: "adjust",
      instanceId: "sample-a",
    });
    const beforeLateCompletion =
      fixture.persistence.getInstance("sample-a")?.state.flowcraftContext;
    releaseFirst?.();
    const late = await first;
    const persisted =
      fixture.persistence.getInstance("sample-a")?.state.flowcraftContext;

    expect(second.executionIds).toHaveLength(2);
    expect(late.executionIds).toHaveLength(3);
    expect(persisted).toMatchObject({
      awaitingNodeIds: ["taste"],
      executionIds: expect.arrayContaining(late.executionIds),
      pendingTransition: null,
      serializedContext: serializedContextFrom(beforeLateCompletion),
    });
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
    });

    expect(completed.status).toBe("completed");
    expect(applied).toHaveLength(4);
    expect(applied).toEqual(
      expect.arrayContaining(["mix", "choose", "left", "right"]),
    );
    fixture.persistence.close();
  });
});
