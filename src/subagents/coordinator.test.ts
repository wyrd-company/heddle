// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it, vi } from "vitest";

import { DispatchPacingGate } from "../pacing/index.js";
import type { InstanceRecord, InstanceState } from "../persistence/index.js";
import type { WorkflowMcpSessionBinding } from "../mcp-server/types.js";
import {
  assignmentForChild,
  type DelegationStateStore,
} from "./delegation-state.js";
import { SubagentCoordinator } from "./coordinator.js";

const initialState = (): InstanceState => ({
  correlationTokens: { parent: "parent-token" },
  flowcraftContext: null,
  handoffs: [
    {
      correlationToken: "parent-token",
      handoff: JSON.stringify({ skillPointer: "skill://sample" }),
      kind: "stage-handoff",
      sessionKey: "parent",
    },
  ],
  todoState: {
    format: "heddle.todo-state",
    lists: [
      {
        assignments: [],
        items: [
          { checked: false, id: "root", text: "Root" },
          { checked: false, id: "child", parentId: "root", text: "Child" },
        ],
        sessionKey: "parent",
        stage: "implement",
        template: "sample-stage",
      },
    ],
    version: 1,
  },
});

class MemoryStore implements DelegationStateStore {
  record: InstanceRecord = {
    instanceId: "instance",
    state: initialState(),
    version: 1,
  };

  compareAndSwapInstance(
    _instanceId: string,
    expectedVersion: number,
    state: InstanceState,
  ) {
    if (expectedVersion !== this.record.version) return undefined;
    this.record = { ...this.record, state, version: this.record.version + 1 };
    return this.record;
  }

  getInstance(instanceId: string) {
    return instanceId === "instance" ? this.record : undefined;
  }

  listInstances() {
    return [this.record];
  }
}

const binding = (store: MemoryStore): WorkflowMcpSessionBinding => ({
  dispositions: [],
  instance: store.record,
  sessionKey: "parent",
  stage: { id: "implement", tools: ["spawn"] },
  taskContext: { title: "Process sample" },
  token: "parent-token",
});

const fixture = (configuration = { maxDepth: 2, maxFanOut: 2 }) => {
  const store = new MemoryStore();
  const bootstrap = vi.fn(async () => ({
    correlationToken: "child-token",
    handoff: "handoff",
    harnessConfiguration: {} as never,
    threadId: "child-thread",
    worktree: { branch: "sample", created: true, path: "/tmp/sample" },
  }));
  const steerParent = vi.fn(async () => undefined);
  let observedPhase: "failed" | "running" = "running";
  const ids = [
    "child-token",
    "child-session",
    "child-thread",
    "create-command",
    "turn-message",
    "turn-command",
    "stop-command",
    "stop-message",
  ];
  const coordinator = new SubagentCoordinator({
    activeSessions: async () => [
      { depth: 0, provider: "sample-provider", sessionId: "parent" },
    ],
    bootstrap,
    bootstrapDependencies: {
      persistence: store,
      t3: { dispatch: async () => ({ sequence: 1 }) },
    },
    nextId: () => ids.shift() ?? "notice-id",
    observeChild: async () => ({
      archiveDispatched: false,
      attentions: [],
      phase: observedPhase,
    }),
    pacing: new DispatchPacingGate(
      {
        defaultProvider: "sample-provider",
        maxConcurrentSessions: 4,
        providerBudgets: {},
        subagents: configuration,
        usageWindowHours: 5,
      },
      { readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }) },
    ),
    persistence: store,
    prepareSession: async ({ identity, model }) => ({
      interactionMode: "default",
      modelSelection: { instanceId: "sample-driver", model },
      projectId: "sample-project",
      providerContext: {
        cliVersion: "sample-version",
        driver: "sample-driver",
        lifecycle: "independent",
      },
      runtimeMode: "default",
      title: "Child sample",
      worktree: {
        baseRef: "main",
        branch: `sample/${identity.sessionKey}`,
        repositoryName: "sample-repository",
        repositoryRoot: "/workspaces/sample-repository",
        worktreeName: identity.sessionKey,
      },
    }),
    sessionTargetFor: () => ({
      instanceId: "instance",
      sessionKey: "parent",
      threadId: "parent-thread",
    }),
    steerParent,
  });
  return {
    bootstrap,
    coordinator,
    setObservedPhase(phase: "failed" | "running") {
      observedPhase = phase;
    },
    steerParent,
    store,
  };
};

const spawn = (coordinator: SubagentCoordinator, store: MemoryStore) =>
  coordinator.spawn(binding(store), {
    model: "sample-model",
    operationId: "spawn-one",
    provider: "sample-provider",
    rootItemId: "root",
  });

describe("SubagentCoordinator", () => {
  it("claims one subtree and bootstraps the child through the stage-session path", async () => {
    const test = fixture();

    await expect(spawn(test.coordinator, test.store)).resolves.toMatchObject({
      assignment: {
        correlationToken: "child-token",
        depth: 1,
        parentSessionKey: "parent",
        rootItemId: "root",
        sessionKey: "child-session",
        threadId: "child-thread",
      },
      kind: "spawned",
    });
    expect(test.bootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        createdAt: expect.any(String),
        parentSessionKey: "parent",
        sessionKey: "child-session",
        threadCreateCommandId: "create-command",
        threadId: "child-thread",
        todoAssignment: { listSessionKey: "parent", rootItemId: "root" },
        turnCommandId: "turn-command",
        turnMessageId: "turn-message",
      }),
      expect.objectContaining({ mintCorrelationToken: expect.any(Function) }),
    );
    const dependencies = test.bootstrap.mock.calls[0]![1];
    expect(dependencies.mintCorrelationToken?.()).toBe("child-token");
  });

  it("replays one operation with its canonical child and bootstrap identities", async () => {
    const test = fixture();

    const first = await spawn(test.coordinator, test.store);
    const replay = await spawn(test.coordinator, test.store);

    expect(replay).toEqual(first);
    expect(test.bootstrap).toHaveBeenCalledTimes(2);
    expect(test.bootstrap.mock.calls[1]?.[0]).toMatchObject(
      test.bootstrap.mock.calls[0]?.[0] ?? {},
    );
    await expect(
      test.coordinator.spawn(binding(test.store), {
        model: "different-model",
        operationId: "spawn-one",
        provider: "sample-provider",
        rootItemId: "root",
      }),
    ).rejects.toThrow(/does not match its stored assignment/);
  });

  it("returns the shared pacing deferral without claiming the subtree", async () => {
    const test = fixture({ maxDepth: 0, maxFanOut: 2 });

    await expect(spawn(test.coordinator, test.store)).resolves.toEqual({
      deferral: {
        limit: 0,
        reason: "subagent-depth-limit",
        requestedDepth: 1,
      },
      kind: "deferred",
    });
    expect(test.store.record.state.correlationTokens).toEqual({
      parent: "parent-token",
    });
    expect(test.bootstrap).not.toHaveBeenCalled();
  });

  it("honors the shared fan-out guard before claiming the subtree", async () => {
    const test = fixture({ maxDepth: 2, maxFanOut: 0 });

    await expect(spawn(test.coordinator, test.store)).resolves.toEqual({
      deferral: {
        activeChildren: 0,
        limit: 0,
        parentSessionId: "parent",
        reason: "subagent-fan-out-limit",
      },
      kind: "deferred",
    });
    expect(test.bootstrap).not.toHaveBeenCalled();
  });

  it("records stop-steer intent before dispatch and replays the same identities", async () => {
    const test = fixture();
    await spawn(test.coordinator, test.store);
    test.steerParent.mockImplementationOnce(async ({ assignment }) => {
      expect(assignment.status).toBe("stopped");
      expect(assignment.stopNotification).toMatchObject({ status: "issued" });
      throw new Error("steer interrupted");
    });
    const target = {
      instanceId: "instance",
      sessionKey: "child-session",
      threadId: "child-thread",
    };
    const stopped = {
      archiveDispatched: false,
      attentions: [],
      phase: "failed" as const,
    };

    await expect(test.coordinator.onObserved(target, stopped)).rejects.toThrow(
      /interrupted/,
    );
    const issued = assignmentForChild(test.store.record, "child-session")
      .assignment.stopNotification;
    expect(issued).toMatchObject({ status: "issued" });

    await expect(
      test.coordinator.onObserved(target, { ...stopped, phase: "absent" }),
    ).resolves.toBeUndefined();
    const replayed =
      test.steerParent.mock.calls[1]![0].assignment.stopNotification;
    expect(replayed).toEqual(issued);
    expect(test.steerParent.mock.calls[1]![0].message).toBe(
      test.steerParent.mock.calls[0]![0].message,
    );
    expect(test.steerParent.mock.calls[1]![0].message).toContain(
      "phase failed",
    );
    expect(test.steerParent.mock.calls[1]![0].message).not.toContain(
      "phase absent",
    );
    expect(
      assignmentForChild(test.store.record, "child-session").assignment
        .stopNotification,
    ).toMatchObject({ status: "completed" });
  });

  it("reports working and crashed states only to the owning parent", async () => {
    const test = fixture();
    await spawn(test.coordinator, test.store);

    await expect(
      test.coordinator.liveness(binding(test.store), "child-session"),
    ).resolves.toMatchObject({ kind: "working", phase: "running" });
    test.setObservedPhase("failed");
    await expect(
      test.coordinator.liveness(binding(test.store), "child-session"),
    ).resolves.toMatchObject({ kind: "crashed", phase: "failed" });
    const foreign = { ...binding(test.store), sessionKey: "foreign" };
    await expect(
      test.coordinator.liveness(foreign, "child-session"),
    ).rejects.toThrow(/not the parent/);
  });
});
