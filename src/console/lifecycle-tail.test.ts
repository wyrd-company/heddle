// ---
// relationships:
//   validates: heddle
// ---

import { describe, expect, it } from "vitest";

import {
  appendLifecycleSnapshot,
  assertLifecycleReplacement,
  lifecycleTraversalCounts,
} from "./lifecycle-tail.js";
import type { ConsoleLifecycleSnapshot } from "./types.js";

const snapshot = (
  events: ConsoleLifecycleSnapshot["events"],
  overrides: Partial<ConsoleLifecycleSnapshot> = {},
): ConsoleLifecycleSnapshot => ({
  blueprint: {
    blobHash: "a".repeat(40),
    edges: [{ source: "prepare", target: "inspect" }],
    id: "sample-lifecycle",
    nodes: [
      { id: "prepare", uses: "function" },
      { id: "inspect", uses: "wait" },
    ],
    path: "blueprints/sample-lifecycle.json",
  },
  currentStageIds: ["inspect"],
  events,
  instanceId: "instance-41",
  nextSequence: events.at(-1)?.sequence ?? 0,
  rebase: {
    available: false,
    targetBlueprintBlobHash: "a".repeat(40),
    targetStateIds: ["inspect"],
  },
  status: "awaiting",
  taskId: 41,
  ...overrides,
});

describe("lifecycle viewer replay and tail", () => {
  it("appends only a contiguous tail with stable instance and blueprint identity", () => {
    const replay = snapshot([
      {
        executionId: "execution-a",
        payload: { nodeId: "prepare" },
        sequence: 1,
        type: "node:start",
      },
    ]);
    assertLifecycleReplacement(replay);
    const combined = appendLifecycleSnapshot(
      replay,
      snapshot([
        {
          executionId: "execution-b",
          payload: { nodeId: "inspect" },
          sequence: 2,
          type: "node:start",
        },
      ]),
    );

    expect(combined.events.map(({ sequence }) => sequence)).toEqual([1, 2]);
    expect(combined.nextSequence).toBe(2);
  });

  it("rejects gaps, overlaps, identity drift, and cursor drift", () => {
    const replay = snapshot([
      {
        executionId: "execution-a",
        payload: { nodeId: "prepare" },
        sequence: 1,
        type: "node:start",
      },
    ]);

    expect(() =>
      appendLifecycleSnapshot(
        replay,
        snapshot([
          {
            executionId: "execution-b",
            payload: { nodeId: "inspect" },
            sequence: 3,
            type: "node:start",
          },
        ]),
      ),
    ).toThrow("Lifecycle tail is not contiguous");
    expect(() =>
      appendLifecycleSnapshot(replay, snapshot([], { instanceId: "other" })),
    ).toThrow("Lifecycle tail identity disagrees");
    expect(() =>
      appendLifecycleSnapshot(replay, snapshot([], { nextSequence: 2 })),
    ).toThrow("Lifecycle tail cursor disagrees");
    expect(() =>
      assertLifecycleReplacement(
        snapshot([
          {
            executionId: "execution-a",
            payload: { nodeId: "prepare" },
            sequence: 2,
            type: "node:start",
          },
        ]),
      ),
    ).toThrow("Lifecycle replay is not contiguous");
  });

  it("exposes repeated node starts as loop traversals", () => {
    expect(
      lifecycleTraversalCounts([
        {
          executionId: "execution-a",
          payload: { nodeId: "inspect" },
          sequence: 1,
          type: "node:start",
        },
        {
          executionId: "execution-b",
          payload: { nodeId: "inspect" },
          sequence: 2,
          type: "node:start",
        },
      ]),
    ).toEqual([{ count: 2, nodeId: "inspect" }]);
  });
});
