// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it, vi } from "vitest";

import type { InstanceRecord, PersistedEvent } from "../persistence/index.js";
import { EscalationCoordinator } from "./escalation-coordinator.js";
import type { WorkflowMcpPersistence } from "./types.js";

describe("escalation coordinator disposition concurrency", () => {
  it("contains one classified Pushover failure within its pending route", async () => {
    const failure = new Error("classified notification failure");
    const events = ["instance-a", "instance-b"].map(
      (instanceId, index): PersistedEvent => ({
        instanceId,
        payload: {
          threadId: "thread-17",
          requestId: "request-one",
          attentionId: `${instanceId}:session:choice`,
          escalationId: "choice",
          instanceId,
          openedAt: "2026-01-01T00:00:00.000Z",
          ownerSessionKey: "session",
          questions: [
            {
              multiSelect: false,
              id: "selection",
              options: [
                {
                  description: "Use the first sample",
                  label: "first",
                },
                {
                  description: "Use the second sample",
                  label: "second",
                },
              ],
              question: "Which sample should be selected?",
            },
          ],
          stage: "sample-stage",
        },
        recordedAt: "2026-01-01T00:00:00.000Z",
        sequence: index + 1,
        type: "mcp:escalation-opened",
      }),
    );
    const appendEvent = vi.fn(
      (
        instanceId: string,
        type: string,
        payload: PersistedEvent["payload"],
      ) => {
        events.push({
          instanceId,
          payload,
          recordedAt: "2026-01-01T00:00:00.000Z",
          sequence: events.length + 1,
          type,
        });
      },
    );
    const records = ["instance-a", "instance-b"].map(
      (instanceId): InstanceRecord => ({
        instanceId,
        state: {
          correlationTokens: {},
          flowcraftContext: null,
          handoffs: [],
          todoState: null,
        },
        version: 1,
      }),
    );
    const persistence: WorkflowMcpPersistence = {
      appendEvent,
      compareAndSwapInstance: vi.fn(),
      compareAndSwapInstanceWithEvent: vi.fn(),
      getInstance: (instanceId) =>
        records.find((record) => record.instanceId === instanceId),
      listInstances: () => records,
      replayEvents: (instanceId) =>
        events.filter((event) => event.instanceId === instanceId),
    };
    const sends = vi.fn(async (attention: { instanceId: string }) => {
      if (attention.instanceId === "instance-a") throw failure;
    });
    const coordinator = new EscalationCoordinator({
      attention: { raise: vi.fn() },
      containPushoverFailure: (error) => error === failure,
      session: { steer: vi.fn() },
      persistence,
      pushover: { send: sends },
    });

    await expect(coordinator.replayPendingRoutes()).resolves.toBeUndefined();

    expect(sends.mock.calls.map(([attention]) => attention.instanceId)).toEqual(
      ["instance-a", "instance-b"],
    );
    expect(
      events.filter(({ type }) => type === "mcp:escalation-notified"),
    ).toMatchObject([{ instanceId: "instance-b" }]);
    sends.mockClear();
    await coordinator.replayPendingRoutes();
    expect(sends.mock.calls.map(([attention]) => attention.instanceId)).toEqual(
      ["instance-a"],
    );
  });

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
          threadId: "thread-17",
          requestId: "request-one",
          attentionId: "instance-a:session-a:choice-a",
          escalationId: "choice-a",
          openedAt: "2026-01-01T00:00:00.000Z",
          ownerSessionKey: "session-a",
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
      session: { steer: vi.fn() },
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

  it("rejects a stale operator answer when authority moves before its compare-and-swap", async () => {
    let record: InstanceRecord = {
      instanceId: "instance-authority",
      state: {
        correlationTokens: {},
        flowcraftContext: null,
        handoffs: [],
        todoState: null,
      },
      version: 1,
    };
    const events: PersistedEvent[] = [
      {
        instanceId: record.instanceId,
        payload: {
          threadId: "thread-17",
          requestId: "request-one",
          attentionId: "attention-authority",
          escalationId: "authority-choice",
          openedAt: "2026-01-01T00:00:00.000Z",
          ownerSessionKey: "owner-session",
          questions: [
            {
              multiSelect: false,
              id: "selection",
              options: [
                {
                  description: "Use the first sample",
                  label: "first",
                },
                {
                  description: "Use the second sample",
                  label: "second",
                },
              ],
              question: "Which sample should be selected?",
            },
          ],
          stage: "sample-stage",
        },
        recordedAt: "2026-01-01T00:00:00.000Z",
        sequence: 1,
        type: "mcp:escalation-opened",
      },
    ];
    const compareAndSwapInstanceWithEvent = vi.fn(() => {
      record = { ...record, version: record.version + 1 };
      events.push({
        instanceId: record.instanceId,
        payload: {
          escalationId: "authority-choice",
          from: { kind: "operator" },
          ownerSessionKey: "owner-session",
          reason: "Delegate this sample decision.",
          to: { kind: "session", sessionKey: "answering-session" },
        },
        recordedAt: "2026-01-01T00:00:01.000Z",
        sequence: 2,
        type: "mcp:escalation-authority-moved",
      });
      return undefined;
    });
    const persistence: WorkflowMcpPersistence = {
      appendEvent: vi.fn(),
      compareAndSwapInstance: vi.fn(),
      compareAndSwapInstanceWithEvent,
      getInstance: () => record,
      listInstances: () => [record],
      replayEvents: () => [...events],
    };
    const coordinator = new EscalationCoordinator({
      attention: { raise: vi.fn() },
      decisionLog: { record: vi.fn() },
      delivery: { deliver: vi.fn() },
      persistence,
      pushover: { send: vi.fn() },
      session: { steer: vi.fn() },
    });

    await expect(
      coordinator.answerAsOperator({
        answers: {
          selection: {
            selectedOptions: ["first"],
            text: "",
            reasoning: "The selected route fits the requested result.",
          },
        },
        escalationId: "authority-choice",
        instanceId: record.instanceId,
        ownerSessionKey: "owner-session",
      }),
    ).rejects.toThrow("does not hold answering authority");
    expect(compareAndSwapInstanceWithEvent).toHaveBeenCalledTimes(1);
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "mcp:escalation-answered" }),
    );
  });
});
