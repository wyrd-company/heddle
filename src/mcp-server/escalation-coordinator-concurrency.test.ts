// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it, vi } from "vitest";

import type { InstanceRecord, PersistedEvent } from "../persistence/index.js";
import { EscalationCoordinator } from "./escalation-coordinator.js";
import type { WorkflowMcpPersistence } from "./types.js";

describe("escalation coordinator disposition concurrency", () => {
  it("rejects advance when escalation wins its stale disposition claim", async () => {
    let record: InstanceRecord = {
      instanceId: "instance-a",
      state: {
        correlationTokens: { "session-a": "token-a" },
        flowcraftContext: {
          awaitingNodeIds: ["sample-stage"],
          blueprintBlobHash: "a".repeat(40),
          blueprintPath: "blueprints/sample-process.json",
          completedOperations: {},
        },
        handoffs: [],
        todoState: null,
      },
      version: 1,
    };
    const events: PersistedEvent[] = [];
    const compareAndSwapInstance = vi.fn(() => {
      record = { ...record, version: record.version + 1 };
      events.push({
        instanceId: "instance-a",
        payload: {
          attentionId: "instance-a:session-a:choice-a",
          escalationId: "choice-a",
          openedAt: "2026-01-01T00:00:00.000Z",
          ownerSessionKey: "session-a",
          questions: [
            {
              id: "label-choice",
              options: [
                {
                  description: "Use the first sample label",
                  id: "first",
                  label: "First",
                },
                {
                  description: "Use the second sample label",
                  id: "second",
                  label: "Second",
                },
              ],
              prompt: "Which sample label should be used?",
            },
          ],
          stage: "sample-stage",
        },
        recordedAt: "2026-01-01T00:00:00.000Z",
        sequence: 1,
        type: "mcp:escalation-opened",
      });
      return undefined;
    });
    const persistence: WorkflowMcpPersistence = {
      appendEvent: vi.fn(),
      compareAndSwapInstance,
      compareAndSwapInstanceWithEvent: vi.fn(),
      getInstance: () => record,
      listInstances: () => [record],
      replayEvents: () => [...events],
    };
    const coordinator = new EscalationCoordinator({
      attention: { raise: vi.fn() },
      parent: { steer: vi.fn() },
      persistence,
      pushover: { send: vi.fn() },
    });
    const resume = vi.fn(async () => "resumed");

    await expect(
      coordinator.resumeAfterNoPending(
        "instance-a",
        "session-a",
        "mcp:advance:session-a",
        resume,
      ),
    ).rejects.toThrow(/pending escalation/);
    expect(compareAndSwapInstance).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
  });
});
