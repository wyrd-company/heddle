// ---
// relationships:
//   validates: heddle
// ---

import { describe, expect, it } from "vitest";

import {
  assertConsoleLifecycleRebaseCurrent,
  ConsoleLifecycleRebaseConflictError,
  parseConsoleLifecycleRebaseRequest,
} from "./lifecycle-rebase-contract.js";
import type { ConsoleLifecycleSnapshot } from "./types.js";

const snapshot = (): ConsoleLifecycleSnapshot => ({
  blueprint: {
    blobHash: "a".repeat(40),
    edges: [],
    id: "sample-process",
    nodes: [{ id: "inspect", uses: "wait" }],
    path: "blueprints/sample-process.json",
  },
  currentStageIds: ["inspect"],
  events: [],
  instanceId: "instance-31",
  nextSequence: 0,
  rebase: {
    available: true,
    targetBlueprintBlobHash: "b".repeat(40),
    targetStateIds: ["inspect", "approve"],
  },
  status: "awaiting",
  taskId: 31,
});

describe("console lifecycle rebase contract", () => {
  it("accepts one exact current instance, pinned blob, target blob, and wait state", () => {
    const request = parseConsoleLifecycleRebaseRequest({
      expectedInstanceId: "instance-31",
      expectedPinnedBlobHash: "a".repeat(40),
      expectedTargetBlobHash: "b".repeat(40),
      targetState: "approve",
    });

    expect(() =>
      assertConsoleLifecycleRebaseCurrent(snapshot(), request),
    ).not.toThrow();
  });

  it.each([
    ["instance", { expectedInstanceId: "instance-32" }],
    ["pinned", { expectedPinnedBlobHash: "c".repeat(40) }],
    ["upstream", { expectedTargetBlobHash: "c".repeat(40) }],
    ["state", { targetState: "missing" }],
  ])("rejects stale %s authority", (_name, override) => {
    const request = parseConsoleLifecycleRebaseRequest({
      expectedInstanceId: "instance-31",
      expectedPinnedBlobHash: "a".repeat(40),
      expectedTargetBlobHash: "b".repeat(40),
      targetState: "approve",
      ...override,
    });

    expect(() =>
      assertConsoleLifecycleRebaseCurrent(snapshot(), request),
    ).toThrow(ConsoleLifecycleRebaseConflictError);
  });

  it("rejects unknown fields and malformed Git identities", () => {
    expect(() =>
      parseConsoleLifecycleRebaseRequest({
        expectedInstanceId: "instance-31",
        expectedPinnedBlobHash: "not-a-hash",
        expectedTargetBlobHash: "b".repeat(40),
        targetState: "inspect",
      }),
    ).toThrow("must be Git object IDs");
    expect(() =>
      parseConsoleLifecycleRebaseRequest({
        expectedInstanceId: "instance-31",
        expectedPinnedBlobHash: "a".repeat(40),
        expectedTargetBlobHash: "b".repeat(40),
        extra: true,
        targetState: "inspect",
      }),
    ).toThrow("unknown fields");
  });
});
