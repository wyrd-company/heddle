// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import type {
  InstanceRecord,
  InstanceState,
  JsonValue,
  PersistedEvent,
} from "../persistence/index.js";
import type { PendingEscalation } from "../mcp-server/index.js";
import { SessionObserver } from "./session-observation.js";
import { observationHash } from "./session-observation-attention.js";
import {
  interruptSession,
  stopSession,
} from "./session-observation-effects.js";
import { sessionObservationEventTypes } from "./session-observation-events.js";
import type {
  SessionObservationAttention,
  SessionObservationAttentionQueue,
  SessionObservationEscalations,
  SessionObservationOptions,
  SessionObservationPersistence,
  SessionObservationT3Client,
  SessionObservationTarget,
} from "./session-observation-types.js";
import type {
  T3DispatchCommand,
  T3ShellSnapshot,
  T3ThreadSnapshot,
} from "./t3-control-plane-client.js";

const target: SessionObservationTarget = {
  instanceId: "sample-one",
  sessionKey: "mix-one",
  threadId: "thread-one",
};

const userInputQuestions = [
  {
    header: "Question",
    id: "quantity",
    multiSelect: false,
    options: [
      { description: "Use a small batch", label: "Small" },
      { description: "Use a large batch", label: "Large" },
    ],
    question: "Which batch size should be used?",
  },
];

const lifecycleContext = (terminal = false): JsonValue => ({
  awaitingNodeIds: terminal ? [] : ["mix"],
  blueprintBlobHash: "a".repeat(40),
  blueprintPath: "blueprints/sample.json",
  completedOperations: terminal
    ? {
        "mcp:advance:mix-one": {
          awaitingNodeIds: [],
          executionIds: [],
          requestFingerprint: "complete",
          status: "completed",
          transitionId: "sample-one:2",
        },
      }
    : {},
  executionIds: [],
  nextTransitionNumber: 2,
  pendingAttentions: [],
  pendingTransition: null,
  serializedContext: "{}",
  status: terminal ? "completed" : "awaiting",
});

const state = (terminal = false): InstanceState => ({
  correlationTokens: { "mix-one": "token-mix" },
  flowcraftContext: lifecycleContext(terminal),
  handoffs: [],
  todoState: null,
});

class MemoryPersistence implements SessionObservationPersistence {
  readonly events: PersistedEvent[] = [];
  record: InstanceRecord = {
    instanceId: target.instanceId,
    state: state(),
    version: 1,
  };

  appendEvent(instanceId: string, type: string, payload: JsonValue) {
    const event = {
      instanceId,
      payload,
      recordedAt: new Date(0).toISOString(),
      sequence: this.events.length + 1,
      type,
    };
    this.events.push(event);
    return event;
  }

  getInstance(instanceId: string) {
    return instanceId === this.record.instanceId ? this.record : undefined;
  }

  listInstances() {
    return [this.record];
  }

  replayEvents(instanceId: string, afterSequence = 0) {
    return this.events.filter(
      (event) =>
        event.instanceId === instanceId && event.sequence > afterSequence,
    );
  }
}

class MemoryAttention implements SessionObservationAttentionQueue {
  readonly entries: SessionObservationAttention[] = [];
  readonly resolved = new Set<string>();

  async has(attentionId: string) {
    return this.entries.some((entry) => entry.attentionId === attentionId);
  }

  async raise(attention: SessionObservationAttention) {
    this.entries.push(attention);
  }

  resolve(attentionId: string) {
    if (!this.entries.some((entry) => entry.attentionId === attentionId)) {
      throw new Error(`Attention '${attentionId}' does not exist`);
    }
    const unresolved = !this.resolved.has(attentionId);
    this.resolved.add(attentionId);
    return unresolved;
  }

  unresolved() {
    return this.entries.filter(
      ({ attentionId }) => !this.resolved.has(attentionId),
    );
  }
}

class MemoryEscalations implements SessionObservationEscalations {
  pending: PendingEscalation[] = [];

  pendingEscalations() {
    return this.pending;
  }

  requireNoPendingForSession(_instanceId: string, sessionKey: string) {
    if (
      this.pending.some(
        ({ ownerSessionKey, parentSessionKey }) =>
          ownerSessionKey === sessionKey || parentSessionKey === sessionKey,
      )
    ) {
      throw new Error("Session has a pending escalation");
    }
  }
}

class MemoryT3 implements SessionObservationT3Client {
  readonly commands: T3DispatchCommand[] = [];
  readonly approvalAnswers: unknown[] = [];
  readonly userInputAnswers: unknown[] = [];
  beforeApprovalResponse?: () => void;
  beforeDispatch?: (command: T3DispatchCommand) => void;
  beforeUserInputResponse?: () => void;
  shell: T3ShellSnapshot = {
    threads: [
      {
        id: target.threadId,
        latestTurn: { state: "running" },
        session: { status: "running" },
      },
    ],
  };
  snapshot: T3ThreadSnapshot = { thread: { activities: [] } };

  async dispatch(command: T3DispatchCommand) {
    this.beforeDispatch?.(command);
    this.commands.push(command);
    if (command.type === "thread.archive") {
      this.shell.threads = this.shell.threads.filter(
        ({ id }) => id !== command.threadId,
      );
    }
    return { sequence: this.commands.length };
  }

  async getShell() {
    return this.shell;
  }

  async getThread() {
    return this.snapshot;
  }

  async respondToApproval(
    threadId: string,
    requestId: string,
    decision: "accept" | "reject",
    commandId?: string,
  ) {
    this.beforeApprovalResponse?.();
    this.approvalAnswers.push({ commandId, decision, requestId, threadId });
    const thread = this.shell.threads[0];
    if (thread) thread.hasPendingApprovals = false;
    return { sequence: 1 };
  }

  async respondToUserInput(
    threadId: string,
    requestId: string,
    answers: Record<string, string | string[]>,
    commandId?: string,
  ) {
    this.beforeUserInputResponse?.();
    this.userInputAnswers.push({ answers, commandId, requestId, threadId });
    const thread = this.shell.threads[0];
    if (thread) thread.hasPendingUserInput = false;
    return { sequence: 1 };
  }
}

const fixture = (childStops?: {
  onObserved: NonNullable<
    SessionObservationOptions["childStops"]
  >["onObserved"];
}) => {
  const attention = new MemoryAttention();
  const escalations = new MemoryEscalations();
  const persistence = new MemoryPersistence();
  const t3 = new MemoryT3();
  let now = 1_000;
  let next = 0;
  const options: SessionObservationOptions = {
    attention,
    ...(childStops === undefined ? {} : { childStops }),
    escalations,
    nextId: () => `command-${++next}`,
    now: () => now,
    persistence,
    t3,
    thresholds: {
      endedMilliseconds: 30,
      failedMilliseconds: 20,
      stalledMilliseconds: 40,
    },
  };
  const observer = new SessionObserver(options);
  return {
    attention,
    escalations,
    observer,
    options,
    persistence,
    setNow(value: number) {
      now = value;
    },
    t3,
  };
};

describe("SessionObserver liveness", () => {
  it("offers the settled shell observation to the child-stop hook", async () => {
    const observed: unknown[] = [];
    const test = fixture({
      async onObserved(observedTarget, result) {
        observed.push({ result, target: observedTarget });
      },
    });
    test.t3.shell.threads[0] = {
      id: target.threadId,
      latestTurn: { state: "error" },
      session: { status: "error" },
    };

    await test.observer.observe(target);

    expect(observed).toEqual([
      {
        result: {
          archiveDispatched: false,
          attentions: [],
          phase: "failed",
        },
        target,
      },
    ]);
  });
  it("ignores unrelated primitive instance events while replaying observation state", async () => {
    const test = fixture();
    test.persistence.appendEvent(target.instanceId, "sample:note", "ready");

    await expect(test.observer.observe(target)).resolves.toMatchObject({
      attentions: [],
      phase: "running",
    });
  });

  it.each([
    {
      expected: "ended",
      phase: {
        latestTurn: { state: "completed" },
        session: { status: "ready" },
      },
      threshold: 30,
    },
    {
      expected: "failed",
      phase: { latestTurn: { state: "error" }, session: { status: "error" } },
      threshold: 20,
    },
    {
      expected: "stalled",
      phase: {
        latestTurn: { state: "running" },
        session: { status: "running" },
      },
      threshold: 40,
    },
  ])(
    "raises $expected attention only after its threshold",
    async ({ expected, phase, threshold }) => {
      const test = fixture();
      test.t3.shell.threads = [{ id: target.threadId, ...phase }];

      await expect(test.observer.observe(target)).resolves.toMatchObject({
        attentions: [],
      });
      test.setNow(1_000 + threshold - 1);
      await expect(test.observer.observe(target)).resolves.toMatchObject({
        attentions: [],
      });
      test.setNow(1_000 + threshold);
      await expect(test.observer.observe(target)).resolves.toMatchObject({
        attentions: [{ kind: expected }],
      });
      expect(test.attention.entries).toHaveLength(1);
    },
  );

  it("resets the stall threshold after recorded lifecycle progress", async () => {
    const test = fixture();
    await test.observer.observe(target);
    test.setNow(1_039);
    test.persistence.record = {
      ...test.persistence.record,
      state: {
        ...test.persistence.record.state,
        flowcraftContext: {
          ...(lifecycleContext() as Record<string, JsonValue>),
          awaitingNodeIds: ["shape"],
        },
      },
      version: 2,
    };
    await expect(test.observer.observe(target)).resolves.toMatchObject({
      attentions: [],
    });
    test.setNow(1_078);
    await expect(test.observer.observe(target)).resolves.toMatchObject({
      attentions: [],
    });
  });

  it("resolves every exact prior liveness kind after the bound lifecycle operation completes", async () => {
    const test = fixture();
    test.t3.shell.threads[0] = {
      id: target.threadId,
      latestTurn: { state: "completed" },
      session: { status: "ready" },
    };
    await test.observer.observe(target);
    test.setNow(1_030);
    await test.observer.observe(target);
    test.t3.shell.threads[0] = {
      id: target.threadId,
      latestTurn: { state: "error" },
      session: { status: "error" },
    };
    await test.observer.observe(target);
    test.setNow(1_050);
    await test.observer.observe(target);
    test.t3.shell.threads[0] = {
      id: target.threadId,
      latestTurn: { state: "running" },
      session: { status: "running" },
    };
    await test.observer.observe(target);
    test.setNow(1_090);
    await test.observer.observe(target);
    const liveness = [...test.attention.entries];
    expect(liveness.map(({ kind }) => kind)).toEqual([
      "ended",
      "failed",
      "stalled",
    ]);

    const approval: SessionObservationAttention = {
      attentionId: "approval-one",
      instanceId: target.instanceId,
      kind: "approval",
      message: "Session mix-one has pending approval",
      requestId: "request-one",
      sessionKey: target.sessionKey,
      threadId: target.threadId,
    };
    const otherThread: SessionObservationAttention = {
      attentionId: "other-thread-ended",
      instanceId: target.instanceId,
      kind: "ended",
      message: "Another session ended",
      sessionKey: target.sessionKey,
      threadId: "thread-two",
    };
    for (const attention of [approval, otherThread]) {
      test.attention.entries.push(attention);
      test.persistence.appendEvent(
        target.instanceId,
        sessionObservationEventTypes.attentionRequired,
        attention,
      );
    }
    test.persistence.record = {
      ...test.persistence.record,
      state: state(true),
      version: 2,
    };

    await expect(test.observer.observe(target)).resolves.toMatchObject({
      attentions: [],
    });
    expect(test.attention.resolved).toEqual(
      new Set(liveness.map(({ attentionId }) => attentionId)),
    );
    expect(test.attention.unresolved()).toEqual([approval, otherThread]);
    const eventCount = test.persistence.events.length;

    await test.observer.observe(target);

    expect(test.attention.resolved).toEqual(
      new Set(liveness.map(({ attentionId }) => attentionId)),
    );
    expect(test.persistence.events).toHaveLength(eventCount);
  });

  it("keeps liveness attention current when only another session operation completes", async () => {
    const test = fixture();
    await test.observer.observe(target);
    test.setNow(1_040);
    await test.observer.observe(target);
    const context = lifecycleContext() as Record<string, JsonValue>;
    context["completedOperations"] = {
      "mcp:advance:other-session": {
        awaitingNodeIds: [],
        executionIds: [],
        requestFingerprint: "complete",
        status: "completed",
        transitionId: "sample-one:2",
      },
    };
    test.persistence.record = {
      ...test.persistence.record,
      state: {
        ...test.persistence.record.state,
        flowcraftContext: context,
      },
      version: 2,
    };

    await test.observer.observe(target);

    expect(test.attention.resolved).toEqual(new Set());
    expect(test.attention.unresolved()).toHaveLength(1);
  });

  it("fails closed instead of resolving a malformed liveness attention identity", async () => {
    const test = fixture();
    await test.observer.observe(target);
    test.setNow(1_040);
    await test.observer.observe(target);
    const validId = test.attention.entries[0]!.attentionId;
    const malformed: SessionObservationAttention = {
      attentionId: "not-the-observed-liveness-identity",
      instanceId: target.instanceId,
      kind: "stalled",
      message: "Malformed observation",
      sessionKey: target.sessionKey,
      threadId: target.threadId,
    };
    test.attention.entries.push(malformed);
    test.persistence.appendEvent(
      target.instanceId,
      sessionObservationEventTypes.attentionRequired,
      malformed,
    );
    test.persistence.record = {
      ...test.persistence.record,
      state: state(true),
      version: 2,
    };

    await expect(test.observer.observe(target)).rejects.toThrow(
      "disagrees with its liveness sample",
    );
    expect(test.attention.resolved).toEqual(new Set());
    expect(
      test.attention.unresolved().map(({ attentionId }) => attentionId),
    ).toEqual([validId, malformed.attentionId]);
  });

  it("resolves completed-operation liveness before an independent archive failure", async () => {
    const test = fixture();
    await test.observer.observe(target);
    test.setNow(1_040);
    await test.observer.observe(target);
    const attentionId = test.attention.entries[0]!.attentionId;
    makeTerminal(test);
    test.t3.beforeDispatch = ({ type }) => {
      if (type === "thread.archive") {
        throw new Error("Injected archive failure");
      }
    };

    await expect(test.observer.observe(target)).rejects.toThrow(
      "Injected archive failure",
    );
    expect(test.attention.resolved).toEqual(new Set([attentionId]));
    expect(test.attention.unresolved()).toEqual([]);
  });
});

describe("SessionObserver operator actions", () => {
  const observeUserInputQuestions = async (questions: unknown[]) => {
    const test = fixture();
    test.t3.shell.threads[0] = {
      id: target.threadId,
      hasPendingUserInput: true,
      latestTurn: { state: "running" },
      session: { status: "running" },
    };
    test.t3.snapshot = {
      thread: {
        activities: [
          {
            kind: "user-input.requested",
            payload: { questions, requestId: "question-one" },
          },
        ],
      },
    };
    return test.observer.observe(target);
  };

  it("projects pending approval and user input as independently answerable attention", async () => {
    const test = fixture();
    test.t3.shell.threads[0] = {
      id: target.threadId,
      hasPendingApprovals: true,
      hasPendingUserInput: true,
      latestTurn: { state: "running" },
      session: { status: "running" },
    };
    test.t3.snapshot = {
      thread: {
        activities: [
          {
            kind: "approval.requested",
            payload: { requestId: "approval-one" },
          },
          {
            kind: "user-input.requested",
            payload: {
              questions: userInputQuestions,
              requestId: "question-one",
            },
          },
        ],
      },
    };

    const result = await test.observer.observe(target);
    expect(result.attentions).toMatchObject([
      { kind: "approval", requestId: "approval-one" },
      {
        kind: "user-input",
        questions: userInputQuestions,
        requestId: "question-one",
      },
    ]);
    await test.observer.answerApproval(target, "approval-one", "accept");
    await test.observer.answerUserInput(target, "question-one", {
      quantity: "Small",
    });
    expect(test.t3.approvalAnswers).toMatchObject([
      { decision: "accept", requestId: "approval-one" },
    ]);
    expect(test.t3.userInputAnswers).toMatchObject([
      { answers: { quantity: "Small" }, requestId: "question-one" },
    ]);
  });

  it("keeps an older approval actionable after a newer request resolves", async () => {
    const test = fixture();
    test.t3.shell.threads[0] = {
      id: target.threadId,
      hasPendingApprovals: true,
      latestTurn: { state: "running" },
      session: { status: "running" },
    };
    test.t3.snapshot = {
      thread: {
        activities: [
          {
            kind: "approval.requested",
            payload: {
              requestId: "approval-older",
              toolCallId: "tool-older",
              toolTitle: "Read catalog",
            },
          },
          {
            kind: "approval.requested",
            payload: {
              requestId: "approval-newer",
              toolCallId: "tool-newer",
              toolTitle: "Update catalog",
            },
          },
          {
            kind: "approval.resolved",
            payload: { requestId: "approval-newer" },
          },
        ],
      },
    };

    const result = await test.observer.observe(target);

    expect(result.attentions).toMatchObject([
      {
        kind: "approval",
        message: "Session mix-one requests approval for Read catalog",
        requestId: "approval-older",
      },
    ]);
  });

  it("projects each unresolved approval exactly once across observation retries", async () => {
    const test = fixture();
    test.t3.shell.threads[0] = {
      id: target.threadId,
      hasPendingApprovals: true,
      latestTurn: { state: "running" },
      session: { status: "running" },
    };
    test.t3.snapshot = {
      thread: {
        activities: [
          {
            kind: "approval.requested",
            payload: {
              requestId: "approval-first",
              toolCallId: "tool-first",
              toolTitle: "Read catalog",
            },
          },
          {
            kind: "approval.requested",
            payload: {
              requestId: "approval-second",
              toolCallId: "tool-second",
              toolTitle: "Update catalog",
            },
          },
        ],
      },
    };

    const first = await test.observer.observe(target);
    const retry = await test.observer.observe(target);

    expect(first.attentions).toMatchObject([
      {
        message: "Session mix-one requests approval for Read catalog",
        requestId: "approval-first",
      },
      {
        message: "Session mix-one requests approval for Update catalog",
        requestId: "approval-second",
      },
    ]);
    expect(retry.attentions).toEqual(first.attentions);
    expect(test.attention.entries).toHaveLength(2);
    expect(
      test.persistence.events.filter(
        ({ type }) => type === sessionObservationEventTypes.attentionRequired,
      ),
    ).toHaveLength(2);
  });

  it("keeps the generic approval message for mixed-version and unsafe metadata", async () => {
    const test = fixture();
    test.t3.shell.threads[0] = {
      id: target.threadId,
      hasPendingApprovals: true,
      latestTurn: { state: "running" },
      session: { status: "running" },
    };
    test.t3.snapshot = {
      thread: {
        activities: [
          {
            kind: "approval.requested",
            payload: {
              args: { note: "not display metadata" },
              detail: "not display metadata",
              requestId: "approval-legacy",
            },
          },
          {
            kind: "approval.requested",
            payload: {
              requestId: "approval-control",
              toolTitle: "Unsafe\ntitle",
            },
          },
          {
            kind: "approval.requested",
            payload: {
              requestId: "approval-long",
              toolTitle: "x".repeat(161),
            },
          },
        ],
      },
    };

    const result = await test.observer.observe(target);

    expect(result.attentions).toMatchObject([
      {
        message: "Session mix-one has pending approval",
        requestId: "approval-legacy",
      },
      {
        message: "Session mix-one has pending approval",
        requestId: "approval-control",
      },
      {
        message: "Session mix-one has pending approval",
        requestId: "approval-long",
      },
    ]);
    expect(
      result.attentions.map(({ message }) => message).join(" "),
    ).not.toContain("not display metadata");
  });

  it("does not rewrite an existing generic durable attention when metadata appears", async () => {
    const test = fixture();
    test.t3.shell.threads[0] = {
      id: target.threadId,
      hasPendingApprovals: true,
      latestTurn: { state: "running" },
      session: { status: "running" },
    };
    test.t3.snapshot = {
      thread: {
        activities: [
          {
            kind: "approval.requested",
            payload: {
              requestId: "approval-one",
              toolTitle: "Read catalog",
            },
          },
        ],
      },
    };
    const existing: SessionObservationAttention = {
      attentionId: observationHash(
        target.instanceId,
        target.sessionKey,
        "approval",
        "approval-one",
      ),
      instanceId: target.instanceId,
      kind: "approval",
      message: "Session mix-one has pending approval",
      requestId: "approval-one",
      sessionKey: target.sessionKey,
      threadId: target.threadId,
    };
    test.attention.entries.push(existing);
    test.persistence.appendEvent(
      target.instanceId,
      sessionObservationEventTypes.attentionRequired,
      existing,
    );

    await test.observer.observe(target);

    expect(test.attention.entries).toEqual([existing]);
    expect(
      test.persistence.events.filter(
        ({ type }) => type === sessionObservationEventTypes.attentionRequired,
      ),
    ).toMatchObject([{ payload: existing }]);
  });

  it("removes only the request named by a stale-response failure", async () => {
    const test = fixture();
    test.t3.shell.threads[0] = {
      id: target.threadId,
      hasPendingApprovals: true,
      latestTurn: { state: "running" },
      session: { status: "running" },
    };
    test.t3.snapshot = {
      thread: {
        activities: [
          {
            kind: "approval.requested",
            payload: { requestId: "approval-first" },
          },
          {
            kind: "approval.requested",
            payload: { requestId: "approval-second" },
          },
          {
            kind: "provider.approval.respond.failed",
            payload: {
              detail: "Unknown pending approval request",
              requestId: "approval-second",
            },
          },
        ],
      },
    };

    const result = await test.observer.observe(target);

    expect(result.attentions).toMatchObject([{ requestId: "approval-first" }]);
  });

  it("rejects pending user input without a canonical question catalog", async () => {
    const test = fixture();
    test.t3.shell.threads[0] = {
      id: target.threadId,
      hasPendingUserInput: true,
      latestTurn: { state: "running" },
      session: { status: "running" },
    };
    test.t3.snapshot = {
      thread: {
        activities: [
          {
            kind: "user-input.requested",
            payload: { requestId: "question-one" },
          },
        ],
      },
    };

    await expect(test.observer.observe(target)).rejects.toThrow(
      "has no canonical question catalog",
    );
    expect(test.attention.entries).toEqual([]);
  });

  it("rejects repeated user-input question identities", async () => {
    await expect(
      observeUserInputQuestions([...userInputQuestions, ...userInputQuestions]),
    ).rejects.toThrow("repeats question 'quantity'");
  });

  it("rejects repeated user-input option identities", async () => {
    await expect(
      observeUserInputQuestions([
        {
          ...userInputQuestions[0],
          options: [
            { label: "Small" },
            { description: "Repeated", label: "Small" },
          ],
        },
      ]),
    ).rejects.toThrow("repeats option label 'Small'");
  });

  it("records an interrupt fact before dispatch and replays the completed operation", async () => {
    const test = fixture();
    test.t3.beforeDispatch = ({ type }) => {
      if (type !== "thread.turn.interrupt") return;
      expect(test.persistence.events.at(-1)?.type).toBe(
        sessionObservationEventTypes.interruptIssued,
      );
    };

    await interruptSession(test.options, target, "interrupt-one", () => "id");
    await interruptSession(test.options, target, "interrupt-one", () => "id");

    expect(
      test.t3.commands.filter(({ type }) => type === "thread.turn.interrupt"),
    ).toHaveLength(1);
  });

  it("dispositions pending questions before stopping the session", async () => {
    const test = fixture();
    test.t3.shell.threads[0] = {
      id: target.threadId,
      hasPendingApprovals: true,
      hasPendingUserInput: true,
    };
    test.t3.snapshot = {
      thread: {
        activities: [
          {
            kind: "approval.requested",
            payload: { requestId: "approval-one" },
          },
          {
            kind: "user-input.requested",
            payload: {
              questions: userInputQuestions,
              requestId: "question-one",
            },
          },
        ],
      },
    };
    test.t3.beforeDispatch = ({ type }) => {
      if (type !== "thread.session.stop") return;
      expect(test.t3.approvalAnswers).toHaveLength(1);
      expect(test.t3.userInputAnswers).toHaveLength(1);
      expect(test.persistence.events.at(-1)?.type).toBe(
        sessionObservationEventTypes.sessionStopIssued,
      );
    };
    test.t3.beforeApprovalResponse = () => {
      expect(test.persistence.events.at(-1)?.type).toBe(
        sessionObservationEventTypes.questionDispositionIssued,
      );
    };
    test.t3.beforeUserInputResponse = () => {
      expect(test.persistence.events.at(-1)?.type).toBe(
        sessionObservationEventTypes.questionDispositionIssued,
      );
    };

    await stopSession(
      test.options,
      {
        ...target,
        approvalDecisions: { "approval-one": "reject" },
        operationId: "stop-one",
        userInputAnswers: { "question-one": { quantity: "Large" } },
      },
      () => "id",
    );

    expect(test.t3.commands.at(-1)?.type).toBe("thread.session.stop");

    test.t3.shell.threads[0]!.hasPendingUserInput = true;
    await stopSession(
      test.options,
      {
        ...target,
        approvalDecisions: { "approval-one": "reject" },
        operationId: "stop-one",
        userInputAnswers: { "question-one": { quantity: "Large" } },
      },
      () => "id",
    );
    expect(test.t3.userInputAnswers).toHaveLength(1);
    expect(
      test.t3.commands.filter(({ type }) => type === "thread.session.stop"),
    ).toHaveLength(1);
  });

  it("dispositions every pending approval exactly once before stopping", async () => {
    const test = fixture();
    test.t3.shell.threads[0] = {
      id: target.threadId,
      hasPendingApprovals: true,
    };
    test.t3.snapshot = {
      thread: {
        activities: [
          {
            kind: "approval.requested",
            payload: { requestId: "approval-first" },
          },
          {
            kind: "approval.requested",
            payload: { requestId: "approval-second" },
          },
        ],
      },
    };
    const input = {
      ...target,
      approvalDecisions: {
        "approval-first": "accept" as const,
        "approval-second": "reject" as const,
      },
      operationId: "stop-many",
    };

    await stopSession(test.options, input, () => "id");
    test.t3.shell.threads[0]!.hasPendingApprovals = true;
    await stopSession(test.options, input, () => "id");

    expect(test.t3.approvalAnswers).toMatchObject([
      { decision: "accept", requestId: "approval-first" },
      { decision: "reject", requestId: "approval-second" },
    ]);
    expect(test.t3.approvalAnswers).toHaveLength(2);
    expect(
      test.t3.commands.filter(({ type }) => type === "thread.session.stop"),
    ).toHaveLength(1);
  });

  it("refuses to stop instead of settling a pending question with empty answers", async () => {
    const test = fixture();
    test.t3.shell.threads[0] = {
      id: target.threadId,
      hasPendingUserInput: true,
    };
    test.t3.snapshot = {
      thread: {
        activities: [
          {
            kind: "user-input.requested",
            payload: {
              questions: userInputQuestions,
              requestId: "question-one",
            },
          },
        ],
      },
    };

    await expect(
      stopSession(
        test.options,
        {
          ...target,
          operationId: "stop-one",
          userInputAnswers: { "question-one": {} },
        },
        () => "id",
      ),
    ).rejects.toThrow("Explicit disposition");
    expect(test.t3.commands).toHaveLength(0);
  });

  it("refuses to stop while a Heddle escalation is pending", async () => {
    const test = fixture();
    test.escalations.pending = [
      {
        createdAt: 1,
        escalationId: "choice-one",
        instanceId: target.instanceId,
        ownerSessionKey: target.sessionKey,
        request: {},
        status: "pending",
      },
    ];

    await expect(
      stopSession(
        test.options,
        { ...target, operationId: "stop-one" },
        () => "id",
      ),
    ).rejects.toThrow("pending escalation");
    expect(test.t3.commands).toHaveLength(0);
  });
});

const makeTerminal = (test: ReturnType<typeof fixture>) => {
  test.persistence.record = {
    ...test.persistence.record,
    state: state(true),
    version: 2,
  };
  test.t3.shell.threads[0] = {
    id: target.threadId,
    latestTurn: { state: "completed" },
    session: { status: "ready" },
  };
};

describe("SessionObserver terminal visibility", () => {
  it("archives an eligible lifecycle-terminal thread once across replay", async () => {
    const test = fixture();
    makeTerminal(test);
    test.t3.beforeDispatch = ({ type }) => {
      if (type !== "thread.archive") return;
      expect(test.persistence.events.at(-1)?.type).toBe(
        sessionObservationEventTypes.archiveIssued,
      );
    };

    await expect(test.observer.observe(target)).resolves.toMatchObject({
      archiveDispatched: true,
    });
    test.t3.shell.threads = [
      {
        id: target.threadId,
        latestTurn: { state: "completed" },
        session: { status: "ready" },
      },
    ];
    await expect(test.observer.observe(target)).resolves.toMatchObject({
      archiveDispatched: false,
      phase: "completed",
    });
    expect(
      test.t3.commands.filter(({ type }) => type === "thread.archive"),
    ).toHaveLength(1);
  });

  it("does not archive while the recorded lifecycle stage is not terminal", async () => {
    const test = fixture();
    test.t3.shell.threads[0] = {
      id: target.threadId,
      latestTurn: { state: "completed" },
      session: { status: "ready" },
    };
    await test.observer.observe(target);
    expect(test.t3.commands).toHaveLength(0);
  });

  it("does not archive while T3 approval is pending", async () => {
    const test = fixture();
    makeTerminal(test);
    test.t3.shell.threads[0]!.hasPendingApprovals = true;
    test.t3.snapshot = {
      thread: {
        activities: [
          {
            kind: "approval.requested",
            payload: { requestId: "approval-one" },
          },
        ],
      },
    };
    await test.observer.observe(target);
    expect(test.t3.commands).toHaveLength(0);
  });

  it("does not archive while T3 user input is pending", async () => {
    const test = fixture();
    makeTerminal(test);
    test.t3.shell.threads[0]!.hasPendingUserInput = true;
    test.t3.snapshot = {
      thread: {
        activities: [
          {
            kind: "user-input.requested",
            payload: {
              questions: userInputQuestions,
              requestId: "question-one",
            },
          },
        ],
      },
    };
    await test.observer.observe(target);
    expect(test.t3.commands).toHaveLength(0);
  });

  it("does not archive while a Heddle escalation is pending", async () => {
    const test = fixture();
    makeTerminal(test);
    test.escalations.pending = [
      {
        attentionId: "attention-one",
        escalationId: "choice-one",
        instanceId: target.instanceId,
        openedAt: new Date(0).toISOString(),
        ownerSessionKey: target.sessionKey,
        questions: [],
        stage: "mix",
      },
    ];
    await test.observer.observe(target);
    expect(test.t3.commands).toHaveLength(0);
  });

  it("does not archive while a canonical child conversational handoff remains", async () => {
    const test = fixture();
    makeTerminal(test);
    const context = lifecycleContext(true) as Record<string, JsonValue>;
    context["awaitingNodeIds"] = ["shape"];
    context["status"] = "awaiting";
    test.persistence.record.state = {
      ...test.persistence.record.state,
      correlationTokens: {
        "mix-one": "token-mix",
        "shape-one": "token-shape",
      },
      flowcraftContext: context,
      handoffs: [
        {
          correlationToken: "token-shape",
          handoff: JSON.stringify({
            correlationToken: "token-shape",
            format: "heddle.stage-handoff",
            stage: { name: "shape" },
            taskContract: { batch: "sample" },
            version: 1,
          }),
          kind: "stage-handoff",
          parentSessionKey: target.sessionKey,
          sessionKey: "shape-one",
          workflowMcp: {
            blueprintBlobHash: "a".repeat(40),
            blueprintPath: "blueprints/sample.json",
            dispositions: [{ description: "Finish", name: "complete" }],
            stage: "shape",
            todoTemplate: "sample-shape",
            tools: ["advance", "answer"],
          },
        },
      ],
    };
    await test.observer.observe(target);
    expect(test.t3.commands).toHaveLength(0);
  });

  it("does not archive a lifecycle-terminal thread while T3 still reports active work", async () => {
    const test = fixture();
    makeTerminal(test);
    test.t3.shell.threads[0] = {
      id: target.threadId,
      latestTurn: { state: "running" },
      session: { status: "running" },
    };
    await test.observer.observe(target);
    expect(test.t3.commands).toHaveLength(0);
  });

  it.each(["working", "monitoring"] as const)(
    "does not archive while T3 background liveness is %s",
    async (backgroundLiveness) => {
      const test = fixture();
      makeTerminal(test);
      test.t3.shell.threads[0]!.backgroundLiveness = backgroundLiveness;

      await test.observer.observe(target);

      expect(test.t3.commands).toHaveLength(0);
    },
  );

  it("does not archive when a stale user timestamp is strictly newer than the latest turn", async () => {
    const test = fixture();
    makeTerminal(test);
    test.t3.shell.threads[0] = {
      id: target.threadId,
      latestUserMessageAt: "2026-01-01T00:01:00.000Z",
      latestTurn: {
        state: "completed",
        requestedAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:01.000Z",
        completedAt: "2026-01-01T00:00:30.000Z",
      },
      session: { status: "ready" },
    };

    await test.observer.observe(target);

    expect(test.t3.commands).toHaveLength(0);
  });

  it("archives when the latest user message was adopted at the latest turn timestamp", async () => {
    const test = fixture();
    makeTerminal(test);
    test.t3.shell.threads[0] = {
      id: target.threadId,
      latestUserMessageAt: "2026-01-01T00:01:00.000Z",
      latestTurn: {
        state: "completed",
        requestedAt: "2026-01-01T00:01:00.000Z",
      },
      session: { status: "ready" },
    };

    await test.observer.observe(target);

    expect(test.t3.commands).toEqual([
      expect.objectContaining({
        threadId: target.threadId,
        type: "thread.archive",
      }),
    ]);
  });

  it.each([
    {
      name: "latest user message",
      latestUserMessageAt: "not-a-timestamp",
      requestedAt: "2026-01-01T00:01:00.000Z",
    },
    {
      name: "latest turn",
      latestUserMessageAt: new Date().toISOString(),
      requestedAt: "not-a-timestamp",
      completedAt: new Date().toISOString(),
    },
  ])(
    "does not archive when the $name timestamp is malformed",
    async ({ latestUserMessageAt, requestedAt, completedAt }) => {
      const test = fixture();
      makeTerminal(test);
      test.t3.shell.threads[0] = {
        id: target.threadId,
        latestUserMessageAt,
        latestTurn: { state: "completed", requestedAt, completedAt },
        session: { status: "ready" },
      };

      await test.observer.observe(target);

      expect(test.t3.commands).toHaveLength(0);
    },
  );

  it("does not archive when a latest user message has no corresponding turn timestamps", async () => {
    const test = fixture();
    makeTerminal(test);
    test.t3.shell.threads[0] = {
      id: target.threadId,
      latestUserMessageAt: new Date().toISOString(),
      latestTurn: { state: "completed" },
      session: { status: "ready" },
    };

    await test.observer.observe(target);

    expect(test.t3.commands).toHaveLength(0);
  });

  it("does not archive while T3 has an actionable proposed plan", async () => {
    const test = fixture();
    makeTerminal(test);
    test.t3.shell.threads[0]!.hasActionableProposedPlan = true;

    await test.observer.observe(target);

    expect(test.t3.commands).toHaveLength(0);
  });
});
