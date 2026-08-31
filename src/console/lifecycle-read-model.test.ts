// ---
// relationships:
//   validates: heddle
//   references: flowcraft-gate
// ---

import { describe, expect, it } from "vitest";

import type { LifecycleBlueprint } from "../engine/index.js";
import { buildConsoleLifecycleSnapshot } from "./lifecycle-read-model.js";

const blueprint: LifecycleBlueprint = {
  edges: [
    { source: "prepare", target: "inspect" },
    { condition: "repeat", source: "inspect", target: "prepare" },
  ],
  id: "sample-lifecycle",
  nodes: [
    { id: "prepare", uses: "function" },
    { id: "inspect", uses: "wait" },
  ],
};

describe("console lifecycle read model", () => {
  it("preserves recorded execution and event order behind one global cursor", () => {
    const snapshot = buildConsoleLifecycleSnapshot({
      afterSequence: 1,
      blueprint,
      blueprintBlobHash: "a".repeat(40),
      blueprintPath: "blueprints/sample-lifecycle.json",
      currentStageIds: ["inspect"],
      executionHistories: [
        {
          events: [
            { payload: { nodeId: "prepare" }, type: "node:start" },
            { payload: { nodeId: "prepare" }, type: "node:finish" },
          ],
          executionId: "execution-a",
        },
        {
          events: [
            { payload: { nodeId: "inspect" }, type: "node:start" },
            { payload: { nodeId: "prepare" }, type: "node:start" },
          ],
          executionId: "execution-b",
        },
      ],
      instanceId: "instance-91",
      rebase: {
        state: "inspected",
        targetBlueprintBlobHash: "c".repeat(40),
        targetStateIds: ["inspect"],
      },
      status: "awaiting",
      taskId: 91,
    });

    expect(snapshot.events).toEqual([
      expect.objectContaining({ executionId: "execution-a", sequence: 2 }),
      expect.objectContaining({ executionId: "execution-b", sequence: 3 }),
      expect.objectContaining({ executionId: "execution-b", sequence: 4 }),
    ]);
    expect(snapshot.nextSequence).toBe(4);
    expect(snapshot.currentStageIds).toEqual(["inspect"]);
    expect(snapshot.blueprint).toMatchObject({
      blobHash: "a".repeat(40),
      id: "sample-lifecycle",
      path: "blueprints/sample-lifecycle.json",
    });
    expect(snapshot.rebase).toEqual({
      state: "available",
      targetBlueprintBlobHash: "c".repeat(40),
      targetStateIds: ["inspect"],
    });
  });

  it("represents current and unavailable upstream targets without hash aliasing", () => {
    const make = (
      rebase: Parameters<typeof buildConsoleLifecycleSnapshot>[0]["rebase"],
    ) =>
      buildConsoleLifecycleSnapshot({
        afterSequence: 0,
        blueprint,
        blueprintBlobHash: "a".repeat(40),
        blueprintPath: "blueprints/sample-lifecycle.json",
        currentStageIds: ["inspect"],
        executionHistories: [],
        instanceId: "instance-93",
        rebase,
        status: "awaiting",
        taskId: 93,
      });

    expect(
      make({
        state: "inspected",
        targetBlueprintBlobHash: "a".repeat(40),
        targetStateIds: ["inspect"],
      }).rebase,
    ).toEqual({
      state: "current",
      targetBlueprintBlobHash: "a".repeat(40),
      targetStateIds: ["inspect"],
    });
    expect(make({ state: "upstream-target-unavailable" }).rebase).toEqual({
      state: "upstream-target-unavailable",
    });
  });

  it("rejects identity and topology disagreements before rendering", () => {
    const make = (
      overrides: Partial<
        Parameters<typeof buildConsoleLifecycleSnapshot>[0]
      > = {},
    ) =>
      buildConsoleLifecycleSnapshot({
        afterSequence: 0,
        blueprint,
        blueprintBlobHash: "b".repeat(40),
        blueprintPath: "blueprints/sample-lifecycle.json",
        currentStageIds: ["inspect"],
        executionHistories: [],
        instanceId: "instance-92",
        rebase: {
          state: "inspected",
          targetBlueprintBlobHash: "b".repeat(40),
          targetStateIds: ["inspect"],
        },
        status: "awaiting",
        taskId: 92,
        ...overrides,
      });

    expect(() => make({ currentStageIds: ["missing"] })).toThrow(
      "Lifecycle stage is absent from pinned blueprint",
    );
    expect(() =>
      make({
        executionHistories: [
          { events: [], executionId: "same" },
          { events: [], executionId: "same" },
        ],
      }),
    ).toThrow("Lifecycle history repeats execution");
    expect(() =>
      make({
        blueprint: {
          ...blueprint,
          edges: [{ source: "prepare", target: "missing" }],
        },
      }),
    ).toThrow("Lifecycle edge names a node outside the pinned blueprint");
    expect(() => make({ afterSequence: 1 })).toThrow(
      "Lifecycle event cursor is ahead of persisted history",
    );
    expect(() =>
      make({
        executionHistories: [
          {
            events: [{ payload: { nodeId: "missing" }, type: "node:start" }],
            executionId: "execution-a",
          },
        ],
      }),
    ).toThrow("Lifecycle node event disagrees with pinned blueprint");
  });
});
