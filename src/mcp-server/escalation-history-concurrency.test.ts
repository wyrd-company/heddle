// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it, vi } from "vitest";

import type { InstanceRecord } from "../persistence/index.js";
import { EscalationHistory } from "./escalation-history.js";
import type {
  WorkflowMcpPersistence,
  WorkflowMcpSessionBinding,
} from "./types.js";

describe("escalation history disposition concurrency", () => {
  it("rejects escalation when disposition wins its stale open claim", () => {
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
    const appendEvent = vi.fn(() => {
      throw new Error("a stale open must not append");
    });
    const compareAndSwapInstanceWithEvent = vi.fn(() => {
      record = {
        ...record,
        state: {
          ...record.state,
          flowcraftContext: {
            ...(record.state.flowcraftContext as Record<string, unknown>),
            mcpDispositionClaims: {
              "session-a": "mcp:advance:session-a",
            },
          },
        },
        version: record.version + 1,
      };
      return undefined;
    });
    const persistence: WorkflowMcpPersistence = {
      appendEvent,
      compareAndSwapInstance: vi.fn(),
      compareAndSwapInstanceWithEvent,
      getInstance: () => record,
      listInstances: () => [record],
      replayEvents: () => [],
    };
    const binding: WorkflowMcpSessionBinding = {
      dispositions: [{ description: "Complete the sample", name: "complete" }],
      instance: record,
      sessionKey: "session-a",
      stage: { id: "sample-stage", tools: [] },
      taskContext: { title: "Handle a sample" },
      token: "token-a",
    };

    expect(() =>
      new EscalationHistory(persistence).open(
        binding,
        {
          threadId: "thread-17",
          requestId: "request-one",
          escalationId: "choice-a",
          questions: [
            {
              multiSelect: false,
              id: "label-choice",
              options: [
                {
                  description: "Use the first sample label",
                  label: "first",
                },
                {
                  description: "Use the second sample label",
                  label: "second",
                },
              ],
              question: "Which sample label should be used?",
            },
          ],
        },
        "2026-01-01T00:00:00.000Z",
      ),
    ).toThrow(/claimed disposition authority/);
    expect(compareAndSwapInstanceWithEvent).toHaveBeenCalledTimes(1);
    expect(appendEvent).not.toHaveBeenCalled();
  });
});
