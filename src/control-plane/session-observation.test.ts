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

  async has(attentionId: string) {
    return this.entries.some((entry) => entry.attentionId === attentionId);
  }

  async raise(attention: SessionObservationAttention) {
    this.entries.push(attention);
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
  const observer = new SessionObserver({
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
  });
  return {
    attention,
    escalations,
    observer,
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

    await test.observer.interrupt(target, "interrupt-one");
    await test.observer.interrupt(target, "interrupt-one");

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

    await test.observer.stop({
      ...target,
      approvalDecisions: { "approval-one": "reject" },
      operationId: "stop-one",
      userInputAnswers: { "question-one": { quantity: "Large" } },
    });

    expect(test.t3.commands.at(-1)?.type).toBe("thread.session.stop");

    test.t3.shell.threads[0]!.hasPendingUserInput = true;
    await test.observer.stop({
      ...target,
      approvalDecisions: { "approval-one": "reject" },
      operationId: "stop-one",
      userInputAnswers: { "question-one": { quantity: "Large" } },
    });
    expect(test.t3.userInputAnswers).toHaveLength(1);
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
      test.observer.stop({
        ...target,
        operationId: "stop-one",
        userInputAnswers: { "question-one": {} },
      }),
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
      test.observer.stop({ ...target, operationId: "stop-one" }),
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
