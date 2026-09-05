// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqlitePersistence } from "../persistence/index.js";
import { DurableAttentionQueue } from "./durable-adapters.js";
import { LifecycleAttentionBridge } from "./lifecycle-attention-bridge.js";

describe("production lifecycle attention bridge", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("projects one durable task attention across repeated cadence flushes", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-attention-bridge-"));
    const persistence = new SqlitePersistence({ stateDirectory: root });
    persistence.createInstance("sample-instance", {
      correlationTokens: {},
      flowcraftContext: {
        awaitingNodeIds: [],
        blueprintBlobHash: "0123456789012345678901234567890123456789",
        blueprintPath: "blueprints/sample.json",
        completedOperations: {},
        executionIds: [],
        nextTransitionNumber: 2,
        pendingAttentions: [],
        pendingTransition: {
          disposition: null,
          id: "sample-instance:1",
          initialContext: {},
          kind: "start",
          operationId: null,
          output: null,
          requestFingerprint: null,
        },
        serializedContext: null,
        status: "pending",
      },
      handoffs: [],
      todoState: {},
    });
    persistence.writeReconcilerRuntime({
      boardStatus: "todo",
      instanceId: "sample-instance",
      state: "starting",
      taskId: 42,
    });
    persistence.appendEvent("sample-instance", "lifecycle:attention-required", {
      actualAwaitingNodeIds: [],
      actualStatus: "failed",
      attentionId: "engine-attention",
      errors: [
        {
          cause: { cause: null, message: "Disk is read-only", name: "Error" },
          message: "Node 'prepare' execution failed",
          name: "FlowcraftError",
        },
      ],
      executionId: "execution-a",
      expectedAwaitingNodeIds: ["inspect"],
      expectedTerminalNodeIds: [],
      transitionId: "sample-instance:1",
    });
    const attention = new DurableAttentionQueue(persistence);
    const bridge = new LifecycleAttentionBridge(persistence, attention);

    await bridge.flush();
    await bridge.flush();

    expect(
      attention.resolve(
        "production:lifecycle-execution-failed:task:42:sample-instance:sample-instance:1",
      ),
    ).toBe(true);
    await bridge.flush();

    expect(attention.list()).toEqual([
      expect.objectContaining({
        attentionId:
          "production:lifecycle-execution-failed:task:42:sample-instance:sample-instance:1",
        instanceId: "sample-instance",
        kind: "production-error",
        message: expect.stringContaining(
          "Node 'prepare' execution failed; caused by: Disk is read-only",
        ),
        taskId: 42,
      }),
    ]);

    const current = persistence.getInstance("sample-instance")!;
    persistence.compareAndSwapInstance("sample-instance", current.version, {
      ...current.state,
      flowcraftContext: {
        awaitingNodeIds: ["inspect"],
        blueprintBlobHash: "0123456789012345678901234567890123456789",
        blueprintPath: "blueprints/sample.json",
        completedOperations: {
          "complete-first": {
            awaitingNodeIds: ["inspect"],
            executionIds: ["execution-a"],
            requestFingerprint: "first-request",
            status: "awaiting",
            transitionId: "sample-instance:1",
          },
        },
        executionIds: ["execution-a"],
        nextTransitionNumber: 3,
        pendingAttentions: [],
        pendingTransition: {
          disposition: "complete",
          id: "sample-instance:2",
          initialContext: null,
          kind: "resume",
          operationId: "complete-second",
          output: {},
          requestFingerprint: "second-request",
        },
        serializedContext: "{}",
        status: "awaiting",
      },
    });
    persistence.appendEvent("sample-instance", "lifecycle:attention-required", {
      actualAwaitingNodeIds: [],
      actualStatus: "failed",
      attentionId: "engine-attention-second",
      errors: [],
      executionId: "execution-b",
      expectedAwaitingNodeIds: ["finish"],
      expectedTerminalNodeIds: [],
      transitionId: "sample-instance:2",
    });

    await bridge.flush();

    expect(attention.list()).toEqual([
      expect.objectContaining({
        attentionId:
          "production:lifecycle-execution-failed:task:42:sample-instance:sample-instance:2",
      }),
    ]);
    expect(
      persistence.hasAttention(
        "production:lifecycle-execution-failed:task:42:sample-instance:sample-instance:1",
      ),
    ).toBe(true);
    persistence.close();
  });
});
