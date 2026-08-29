// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it, vi } from "vitest";

import type { InstanceRecord, InstanceState } from "../persistence/index.js";
import type { TodoState } from "../todo/index.js";
import {
  bootstrapStageSession,
  type SessionBootstrapDependencies,
  type SessionBootstrapInput,
} from "./session-bootstrap.js";

const input: SessionBootstrapInput = {
  handoff: {
    skillPointer: "skill://prepare",
    stage: { kind: "standard", name: "prepare", priorStageOutputs: [] },
    taskContract: { title: "Prepare inventory" },
  },
  instanceId: "instance-1",
  interactionMode: "default",
  modelSelection: { instanceId: "cursor", model: "default" },
  projectId: "project-1",
  providerContext: {
    cliVersion: "2026.08.11-e8db854",
    driver: "cursor",
    lifecycle: "independent",
  },
  runtimeMode: "auto",
  sessionKey: "prepare-1",
  title: "Prepare inventory",
  worktree: {
    baseRef: "main",
    branch: "task/prepare",
    repositoryName: "sample-repository",
    repositoryRoot: "/workspaces/sample-repository",
    worktreeName: "task-prepare",
  },
};

const initialState = (): InstanceState => ({
  correlationTokens: {},
  flowcraftContext: null,
  handoffs: [],
  todoState: null,
});

const workflowMcp = {
  blueprintBlobHash: "a".repeat(40),
  blueprintPath: "blueprints/sample-process.json",
  dispositions: [{ description: "Finish the preparation", name: "complete" }],
  stage: "prepare",
  todoTemplate: "sample-prepare",
  tools: ["advance", "get_task_context"],
};

const resolveWorkflowMcpStageContract = async () => workflowMcp;

const instantiateTodoList: NonNullable<
  SessionBootstrapDependencies["instantiateTodoList"]
> = async ({ sessionKey, stage, templateId }) => ({
  items: [{ checked: false, id: "orient", text: "Orient on the sample" }],
  sessionKey,
  stage,
  template: templateId,
});

const memoryStore = (state = initialState()) => {
  let record: InstanceRecord = {
    instanceId: "instance-1",
    state,
    version: 1,
  };
  return {
    get record() {
      return record;
    },
    store: {
      getInstance: () => record,
      compareAndSwapInstance: (
        _id: string,
        version: number,
        nextState: InstanceState,
      ) => {
        if (version !== record.version) return undefined;
        record = { ...record, state: nextState, version: record.version + 1 };
        return record;
      },
    },
  };
};

describe("stage session cold retry guards", () => {
  it("persists parentage only for a child of a bound session", async () => {
    const parentHandoff = {
      correlationToken: "token-parent",
      handoff: "parent handoff",
      kind: "stage-handoff",
      sessionKey: "parent",
      workflowMcp,
    };
    const memory = memoryStore({
      ...initialState(),
      correlationTokens: { parent: "token-parent" },
      handoffs: [parentHandoff],
    });
    const dispatch = vi.fn(async () => ({ sequence: 1 }));

    await bootstrapStageSession(
      { ...input, parentSessionKey: "parent", sessionKey: "child" },
      {
        instantiateTodoList,
        persistence: memory.store,
        resolveWorkflowMcpStageContract,
        t3: { dispatch },
        ensureWorktree: async ({ branch }) => ({
          branch,
          created: false,
          path: "/workspaces/worktrees/sample-repository/task-prepare",
        }),
        mintCorrelationToken: () => "token-child",
        nextId: vi
          .fn()
          .mockReturnValueOnce("thread-child")
          .mockReturnValueOnce("create-child")
          .mockReturnValueOnce("turn-child")
          .mockReturnValueOnce("message-child"),
      },
    );

    expect(memory.record.state.handoffs).toContainEqual(
      expect.objectContaining({
        parentSessionKey: "parent",
        sessionKey: "child",
      }),
    );
  });

  it("rejects an unbound parent before persisting or dispatching", async () => {
    const memory = memoryStore();
    const dispatch = vi.fn(async () => ({ sequence: 1 }));

    await expect(
      bootstrapStageSession(
        { ...input, parentSessionKey: "missing-parent", sessionKey: "child" },
        {
          instantiateTodoList,
          persistence: memory.store,
          resolveWorkflowMcpStageContract,
          t3: { dispatch },
          ensureWorktree: async ({ branch }) => ({
            branch,
            created: false,
            path: "/workspaces/worktrees/sample-repository/task-prepare",
          }),
          mintCorrelationToken: () => "token-child",
        },
      ),
    ).rejects.toThrow(/not bound to this instance/);
    expect(memory.record.state).toEqual(initialState());
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects a retry when the stored parent session disagrees", async () => {
    const memory = memoryStore({
      ...initialState(),
      correlationTokens: {
        child: "token-child",
        "parent-a": "token-parent-a",
        "parent-b": "token-parent-b",
      },
      handoffs: [
        {
          correlationToken: "token-parent-a",
          handoff: "parent a handoff",
          kind: "stage-handoff",
          sessionKey: "parent-a",
          workflowMcp,
        },
        {
          correlationToken: "token-parent-b",
          handoff: "parent b handoff",
          kind: "stage-handoff",
          sessionKey: "parent-b",
          workflowMcp,
        },
        {
          correlationToken: "token-child",
          handoff: "child handoff",
          kind: "stage-handoff",
          parentSessionKey: "parent-a",
          sessionKey: "child",
          workflowMcp,
        },
      ],
    });
    const dispatch = vi.fn(async () => ({ sequence: 1 }));

    await expect(
      bootstrapStageSession(
        { ...input, parentSessionKey: "parent-b", sessionKey: "child" },
        {
          persistence: memory.store,
          resolveWorkflowMcpStageContract,
          t3: { dispatch },
          ensureWorktree: async ({ branch }) => ({
            branch,
            created: false,
            path: "/workspaces/worktrees/sample-repository/task-prepare",
          }),
        },
      ),
    ).rejects.toThrow(/parent session disagree/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("persists and replays the handoff after the initial turn fails", async () => {
    const memory = memoryStore();
    const commands: Record<string, unknown>[] = [];
    const ids = [
      "thread-1",
      "create-1",
      "turn-1",
      "message-1",
      "thread-2",
      "create-2",
      "turn-2",
      "message-2",
    ];
    let failFirstTurn = true;
    const dependencies: SessionBootstrapDependencies = {
      persistence: memory.store,
      instantiateTodoList,
      resolveWorkflowMcpStageContract,
      t3: {
        dispatch: async (command) => {
          commands.push(command);
          if (command.type === "thread.turn.start" && failFirstTurn) {
            failFirstTurn = false;
            throw new Error("turn rejected");
          }
          return { sequence: commands.length };
        },
      },
      ensureWorktree: async ({ branch }) => ({
        branch,
        created: false,
        path: "/workspaces/worktrees/sample-repository/task-prepare",
      }),
      mintCorrelationToken: () => "correlation-token",
      nextId: () => ids.shift()!,
    };

    await expect(bootstrapStageSession(input, dependencies)).rejects.toThrow(
      /turn rejected/,
    );
    const retry = await bootstrapStageSession(input, dependencies);
    const turnCommands = commands.filter(
      ({ type }) => type === "thread.turn.start",
    );

    expect(retry.threadId).toBe("thread-2");
    expect((turnCommands[0]?.["message"] as { text: string }).text).toBe(
      (turnCommands[1]?.["message"] as { text: string }).text,
    );
    expect(memory.record.state.handoffs).toHaveLength(1);
  });

  it("assembles the handoff from the todo state committed at its CAS version", async () => {
    const memory = memoryStore();
    let injected = false;
    const persistence = {
      compareAndSwapInstance: memory.store.compareAndSwapInstance,
      getInstance: (instanceId: string) => {
        const current = memory.store.getInstance(instanceId);
        if (
          !injected &&
          current !== undefined &&
          current.state.todoState !== null &&
          current.state.handoffs.length === 0
        ) {
          injected = true;
          const todoState = current.state.todoState as TodoState;
          memory.store.compareAndSwapInstance(instanceId, current.version, {
            ...current.state,
            todoState: {
              ...todoState,
              lists: todoState.lists.map((list) => ({
                ...list,
                items: list.items.map((item) => ({ ...item, checked: true })),
              })),
            },
          });
          return memory.store.getInstance(instanceId);
        }
        return current;
      },
    };

    const result = await bootstrapStageSession(input, {
      persistence,
      instantiateTodoList,
      resolveWorkflowMcpStageContract,
      t3: { dispatch: async () => ({ sequence: 1 }) },
      ensureWorktree: async ({ branch }) => ({
        branch,
        created: false,
        path: "/workspaces/worktrees/sample-repository/task-prepare",
      }),
      mintCorrelationToken: () => "correlation-token",
      nextId: () => globalThis.crypto.randomUUID(),
    });
    const handoff = JSON.parse(result.handoff) as {
      todoList: { lists: Array<{ items: Array<{ checked: boolean }> }> };
    };

    expect(injected).toBe(true);
    expect(handoff.todoList.lists[0]?.items[0]?.checked).toBe(true);
    expect(memory.record.state.handoffs[0]?.["handoff"]).toBe(result.handoff);
  });

  it("fails closed when the stored handoff token disagrees", async () => {
    const memory = memoryStore({
      ...initialState(),
      correlationTokens: { "prepare-1": "token-1" },
      handoffs: [
        {
          correlationToken: "token-2",
          handoff: "stored handoff",
          kind: "stage-handoff",
          sessionKey: "prepare-1",
          workflowMcp,
        },
      ],
    });
    const dispatch = vi.fn(async () => ({ sequence: 1 }));

    await expect(
      bootstrapStageSession(input, {
        persistence: memory.store,
        instantiateTodoList,
        resolveWorkflowMcpStageContract,
        t3: { dispatch },
        ensureWorktree: async ({ branch }) => ({
          branch,
          created: false,
          path: "/workspaces/worktrees/sample-repository/task-prepare",
        }),
      }),
    ).rejects.toThrow(/disagree/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("fails closed when a stored handoff has no static MCP contract", async () => {
    const memory = memoryStore({
      ...initialState(),
      correlationTokens: { "prepare-1": "token-1" },
      handoffs: [
        {
          correlationToken: "token-1",
          handoff: "stored handoff",
          kind: "stage-handoff",
          sessionKey: "prepare-1",
        },
      ],
    });
    const dispatch = vi.fn(async () => ({ sequence: 1 }));

    await expect(
      bootstrapStageSession(input, {
        persistence: memory.store,
        instantiateTodoList,
        resolveWorkflowMcpStageContract,
        t3: { dispatch },
        ensureWorktree: async ({ branch }) => ({
          branch,
          created: false,
          path: "/workspaces/worktrees/sample-repository/task-prepare",
        }),
      }),
    ).rejects.toThrow(/no valid workflow MCP contract/);
    expect(dispatch).not.toHaveBeenCalled();
    expect(memory.record.state.handoffs).toHaveLength(1);
  });

  it("fails closed when a stored MCP contract names another stage", async () => {
    const memory = memoryStore({
      ...initialState(),
      correlationTokens: { "prepare-1": "token-1" },
      handoffs: [
        {
          correlationToken: "token-1",
          handoff: "stored handoff",
          kind: "stage-handoff",
          sessionKey: "prepare-1",
          workflowMcp: { ...workflowMcp, stage: "inspect" },
        },
      ],
    });
    const dispatch = vi.fn(async () => ({ sequence: 1 }));

    await expect(
      bootstrapStageSession(input, {
        persistence: memory.store,
        instantiateTodoList,
        resolveWorkflowMcpStageContract,
        t3: { dispatch },
        ensureWorktree: async ({ branch }) => ({
          branch,
          created: false,
          path: "/workspaces/worktrees/sample-repository/task-prepare",
        }),
      }),
    ).rejects.toThrow(/workflow MCP stage disagree/);
    expect(dispatch).not.toHaveBeenCalled();
    expect(memory.record.state.handoffs).toHaveLength(1);
  });

  it("fails closed when a stored MCP contract has no todo template binding", async () => {
    const withoutTodoTemplate = { ...workflowMcp } as Partial<
      typeof workflowMcp
    >;
    delete withoutTodoTemplate.todoTemplate;
    const memory = memoryStore({
      ...initialState(),
      correlationTokens: { "prepare-1": "token-1" },
      handoffs: [
        {
          correlationToken: "token-1",
          handoff: "stored handoff",
          kind: "stage-handoff",
          sessionKey: "prepare-1",
          workflowMcp: withoutTodoTemplate,
        },
      ],
    });
    const dispatch = vi.fn(async () => ({ sequence: 1 }));

    await expect(
      bootstrapStageSession(input, {
        persistence: memory.store,
        instantiateTodoList,
        resolveWorkflowMcpStageContract,
        t3: { dispatch },
        ensureWorktree: async ({ branch }) => ({
          branch,
          created: false,
          path: "/workspaces/worktrees/sample-repository/task-prepare",
        }),
      }),
    ).rejects.toThrow(/no valid workflow MCP contract/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not contact T3 when worktree preparation fails", async () => {
    const memory = memoryStore();
    const dispatch = vi.fn(async () => ({ sequence: 1 }));

    await expect(
      bootstrapStageSession(input, {
        persistence: memory.store,
        t3: { dispatch },
        ensureWorktree: async () => {
          throw new Error("worktree rejected");
        },
      }),
    ).rejects.toThrow(/worktree rejected/);
    expect(dispatch).not.toHaveBeenCalled();
    expect(memory.record.state).toEqual(initialState());
  });
});
