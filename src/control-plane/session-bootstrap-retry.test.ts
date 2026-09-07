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
import { HandoffRenderError } from "./handoff-renderer.js";
import {
  sampleHandoffTemplate,
  sampleTemplateAuthority,
} from "./session-bootstrap.test-support.js";

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
    providerInstanceId: "cursor",
  },
  runtimeMode: "auto",
  sessionKey: "prepare-1",
  task: { id: 1, title: "Prepare inventory" },
  taskId: 1,
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
  handoffTemplate: sampleHandoffTemplate,
  skills: [],
  stage: "prepare",
  todoTemplate: "sample-prepare",
  tools: ["advance", "answer", "get_task_context"],
};

const resolveWorkflowMcpStageContract = async () => workflowMcp;

const handoffDocument = (token: string, stage = "prepare") =>
  JSON.stringify({
    format: "heddle.stage-handoff",
    stage: { name: stage, skills: [] },
    taskContract: { title: "Prepare a sample" },
    version: 1,
  });

const withParentAuthority = (state: InstanceState): InstanceState =>
  state.flowcraftContext === null
    ? {
        ...state,
        flowcraftContext: {
          awaitingNodeIds: ["prepare"],
          blueprintBlobHash: "a".repeat(40),
          blueprintPath: "blueprints/sample-process.json",
          completedOperations: {},
        },
      }
    : state;

const instantiateTodoList: NonNullable<
  SessionBootstrapDependencies["instantiateTodoList"]
> = async ({ sessionKey, stage, templateId }) => ({
  items: [{ checked: false, id: "orient", text: "Orient on the sample" }],
  sessionKey,
  stage,
  template: templateId,
});

const registerWorkflowMcpProviderSession = async (): Promise<void> => undefined;
const workflowMcpEndpoint = "http://127.0.0.1:4774/mcp";

const memoryStore = (
  state = initialState(),
  otherRecords: InstanceRecord[] = [],
) => {
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
      listInstances: () => [record, ...otherRecords],
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

const expectParentRejected = async (
  state: InstanceState,
  otherRecords: InstanceRecord[] = [],
) => {
  const memory = memoryStore(withParentAuthority(state), otherRecords);
  const dispatch = vi.fn(async () => ({ sequence: 1 }));
  await expect(
    bootstrapStageSession(
      { ...input, parentSessionKey: "parent", sessionKey: "child" },
      {
        instantiateTodoList,
        persistence: memory.store,
        templateAuthority: sampleTemplateAuthority,
        resolveWorkflowMcpStageContract,
        workflowMcpEndpoint,
        t3: { registerWorkflowMcpProviderSession, dispatch },
        ensureWorktree: async ({ branch }) => ({
          branch,
          created: false,
          path: "/workspaces/worktrees/sample-repository/task-prepare",
        }),
      },
    ),
  ).rejects.toThrow(/not bound to this instance/);
  expect(dispatch).not.toHaveBeenCalled();
};

describe("stage session cold retry guards", () => {
  it("rejects mismatched T3 driver identities before any bootstrap effect", async () => {
    const memory = memoryStore();
    const ensureWorktree = vi.fn(async ({ branch }) => ({
      branch,
      created: false,
      path: "/workspaces/worktrees/sample-repository/task-prepare",
    }));
    const mintCorrelationToken = vi.fn(() => "correlation-token");
    const nextId = vi.fn(() => "stable-id");
    const applyHarnessToolTimeout = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => ({ sequence: 1 }));

    const error = await bootstrapStageSession(
      {
        ...input,
        modelSelection: { ...input.modelSelection, instanceId: "claudeAgent" },
      },
      {
        persistence: memory.store,
        ensureWorktree,
        mintCorrelationToken,
        nextId,
        workflowMcpEndpoint,
        t3: {
          registerWorkflowMcpProviderSession,
          applyHarnessToolTimeout,
          dispatch,
        },
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HandoffRenderError);
    expect(error).toMatchObject({
      message: expect.stringContaining(
        "model selection and provider context must name the same provider instance",
      ),
    });
    expect(ensureWorktree).not.toHaveBeenCalled();
    expect(mintCorrelationToken).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    expect(applyHarnessToolTimeout).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(memory.record).toMatchObject({ state: initialState(), version: 1 });
  });

  it.each([
    {
      body: '{% include "handoff-templates/includes/../outside.md" %}',
      case: "an escaping include",
      diagnostic: "repository-relative path inside handoff-templates/includes/",
      includes: {
        "handoff-templates/includes/../outside.md": "Outside content",
      },
    },
    {
      body: '{% extends "handoff-templates/includes/layout.md" %}',
      case: "extends syntax",
      diagnostic: "uses unsupported Extends syntax; only include is supported",
      includes: {
        "handoff-templates/includes/layout.md": "Layout content",
      },
    },
    {
      body: '{% import "handoff-templates/includes/macros.md" as macros %}',
      case: "import syntax",
      diagnostic: "uses unsupported Import syntax; only include is supported",
      includes: {
        "handoff-templates/includes/macros.md":
          "{% macro item() %}Macro content{% endmacro %}",
      },
    },
  ])(
    "rejects $case before timeout, registration, or T3 dispatch",
    async ({ body, diagnostic, includes }) => {
      const memory = memoryStore();
      const applyHarnessToolTimeout = vi.fn(async () => undefined);
      const dispatch = vi.fn(async () => ({ sequence: 1 }));
      const register = vi.fn(async () => undefined);

      const error = await bootstrapStageSession(input, {
        instantiateTodoList,
        persistence: memory.store,
        resolveWorkflowMcpStageContract,
        templateAuthority: {
          repositoryRoot: sampleTemplateAuthority.repositoryRoot,
          readHandoffTemplate: async (reference) => ({
            ...reference,
            body,
            includes,
            kind: "standard",
            skills: {},
          }),
        },
        workflowMcpEndpoint,
        t3: {
          applyHarnessToolTimeout,
          dispatch,
          registerWorkflowMcpProviderSession: register,
        },
        ensureWorktree: async ({ branch }) => ({
          branch,
          created: false,
          path: "/workspaces/worktrees/sample-repository/task-prepare",
        }),
        mintCorrelationToken: () => "correlation-token",
        nextId: () => "stable-id",
      }).catch((caught: unknown) => caught);

      expect(applyHarnessToolTimeout).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(error).toBeInstanceOf(HandoffRenderError);
      expect(error).toMatchObject({
        message: expect.stringContaining(diagnostic),
      });
    },
  );

  it("rejects a correlation token in pinned skill source before any T3 effect", async () => {
    const memory = memoryStore();
    const applyHarnessToolTimeout = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => ({ sequence: 1 }));
    const register = vi.fn(async () => undefined);
    const skilledInput: SessionBootstrapInput = {
      ...input,
      handoff: {
        ...input.handoff,
        stage: { ...input.handoff.stage, skills: ["evidence-review"] },
      },
    };

    await expect(
      bootstrapStageSession(skilledInput, {
        instantiateTodoList,
        persistence: memory.store,
        resolveWorkflowMcpStageContract: async () => ({
          ...workflowMcp,
          skills: ["evidence-review"],
        }),
        templateAuthority: {
          repositoryRoot: sampleTemplateAuthority.repositoryRoot,
          readHandoffTemplate: async (reference, skillNames) => {
            expect(skillNames).toEqual(["evidence-review"]);
            return {
              ...reference,
              body: '{{ skill("evidence-review").description }}',
              includes: {},
              kind: "standard",
              skills: {
                "evidence-review": {
                  description: "Inspect evidence.",
                  name: "evidence-review",
                  path: "skills/evidence-review/SKILL.md",
                  source: "Body contains correlation-token",
                },
              },
            };
          },
        },
        workflowMcpEndpoint,
        t3: {
          applyHarnessToolTimeout,
          dispatch,
          registerWorkflowMcpProviderSession: register,
        },
        ensureWorktree: async ({ branch }) => ({
          branch,
          created: false,
          path: "/workspaces/worktrees/sample-repository/task-prepare",
        }),
        mintCorrelationToken: () => "correlation-token",
      }),
    ).rejects.toThrow("Pinned skill source contains the correlation token");
    expect(applyHarnessToolTimeout).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects handoff skill names that disagree with the pinned blueprint contract", async () => {
    const memory = memoryStore();
    const dispatch = vi.fn(async () => ({ sequence: 1 }));

    await expect(
      bootstrapStageSession(input, {
        instantiateTodoList,
        persistence: memory.store,
        resolveWorkflowMcpStageContract: async () => ({
          ...workflowMcp,
          skills: ["evidence-review"],
        }),
        templateAuthority: sampleTemplateAuthority,
        workflowMcpEndpoint,
        t3: { registerWorkflowMcpProviderSession, dispatch },
        ensureWorktree: async ({ branch }) => ({
          branch,
          created: false,
          path: "/workspaces/worktrees/sample-repository/task-prepare",
        }),
      }),
    ).rejects.toThrow("skills do not match the pinned blueprint contract");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("persists parentage only for a child of a bound session", async () => {
    const parentHandoff = {
      correlationToken: "token-parent",
      handoff: handoffDocument("token-parent"),
      kind: "stage-handoff",
      sessionKey: "parent",
      workflowMcp,
    };
    const memory = memoryStore(
      withParentAuthority({
        ...initialState(),
        correlationTokens: { parent: "token-parent" },
        handoffs: [parentHandoff],
      }),
    );
    const dispatch = vi.fn(async () => ({ sequence: 1 }));

    await bootstrapStageSession(
      { ...input, parentSessionKey: "parent", sessionKey: "child" },
      {
        instantiateTodoList,
        persistence: memory.store,
        templateAuthority: sampleTemplateAuthority,
        resolveWorkflowMcpStageContract,
        workflowMcpEndpoint,
        t3: { registerWorkflowMcpProviderSession, dispatch },
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

  it("rejects a parent whose stored handoff document is malformed", async () => {
    await expectParentRejected({
      ...initialState(),
      correlationTokens: { parent: "token-parent" },
      handoffs: [
        {
          correlationToken: "token-parent",
          handoff: "not-json",
          kind: "stage-handoff",
          sessionKey: "parent",
          workflowMcp,
        },
      ],
    });
  });

  it("rejects a parent whose stored handoff token disagrees", async () => {
    await expectParentRejected({
      ...initialState(),
      correlationTokens: { parent: "token-parent" },
      handoffs: [
        {
          correlationToken: "token-other",
          handoff: handoffDocument("token-other"),
          kind: "stage-handoff",
          sessionKey: "parent",
          workflowMcp,
        },
      ],
    });
  });

  it("rejects a parent with more than one canonical stored handoff", async () => {
    const parentHandoff = {
      correlationToken: "token-parent",
      handoff: handoffDocument("token-parent"),
      kind: "stage-handoff" as const,
      sessionKey: "parent",
      workflowMcp,
    };
    await expectParentRejected({
      ...initialState(),
      correlationTokens: { parent: "token-parent" },
      handoffs: [parentHandoff, { ...parentHandoff }],
    });
  });

  it("rejects a parent token bound in more than one instance", async () => {
    const parentHandoff = {
      correlationToken: "token-parent",
      handoff: handoffDocument("token-parent"),
      kind: "stage-handoff" as const,
      sessionKey: "parent",
      workflowMcp,
    };
    await expectParentRejected(
      {
        ...initialState(),
        correlationTokens: { parent: "token-parent" },
        handoffs: [parentHandoff],
      },
      [
        {
          instanceId: "instance-other",
          state: {
            ...initialState(),
            correlationTokens: { other: "token-parent" },
          },
          version: 1,
        },
      ],
    );
  });

  it("rejects a completed parent whose MCP authority has no answer tool", async () => {
    await expectParentRejected({
      ...initialState(),
      correlationTokens: { parent: "token-parent" },
      flowcraftContext: {
        awaitingNodeIds: ["prepare"],
        blueprintBlobHash: "a".repeat(40),
        blueprintPath: "blueprints/sample-process.json",
        completedOperations: { "mcp:advance:parent": {} },
      },
      handoffs: [
        {
          correlationToken: "token-parent",
          handoff: handoffDocument("token-parent"),
          kind: "stage-handoff",
          sessionKey: "parent",
          workflowMcp,
        },
      ],
    });
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
          templateAuthority: sampleTemplateAuthority,
          resolveWorkflowMcpStageContract,
          workflowMcpEndpoint,
          t3: { registerWorkflowMcpProviderSession, dispatch },
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

  it("rejects a session that names itself as its parent", async () => {
    const memory = memoryStore();
    const dispatch = vi.fn(async () => ({ sequence: 1 }));

    await expect(
      bootstrapStageSession(
        { ...input, parentSessionKey: "child", sessionKey: "child" },
        {
          instantiateTodoList,
          persistence: memory.store,
          templateAuthority: sampleTemplateAuthority,
          resolveWorkflowMcpStageContract,
          workflowMcpEndpoint,
          t3: { registerWorkflowMcpProviderSession, dispatch },
          ensureWorktree: async ({ branch }) => ({
            branch,
            created: false,
            path: "/workspaces/worktrees/sample-repository/task-prepare",
          }),
          mintCorrelationToken: () => "token-child",
        },
      ),
    ).rejects.toThrow(/cannot be its own parent/);
    expect(memory.record.state).toEqual(initialState());
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects a retry when the stored parent session disagrees", async () => {
    const memory = memoryStore(
      withParentAuthority({
        ...initialState(),
        correlationTokens: {
          child: "token-child",
          "parent-a": "token-parent-a",
          "parent-b": "token-parent-b",
        },
        handoffs: [
          {
            correlationToken: "token-parent-a",
            handoff: handoffDocument("token-parent-a"),
            kind: "stage-handoff",
            sessionKey: "parent-a",
            workflowMcp,
          },
          {
            correlationToken: "token-parent-b",
            handoff: handoffDocument("token-parent-b"),
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
      }),
    );
    const dispatch = vi.fn(async () => ({ sequence: 1 }));

    await expect(
      bootstrapStageSession(
        { ...input, parentSessionKey: "parent-b", sessionKey: "child" },
        {
          persistence: memory.store,
          templateAuthority: sampleTemplateAuthority,
          resolveWorkflowMcpStageContract,
          workflowMcpEndpoint,
          t3: { registerWorkflowMcpProviderSession, dispatch },
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
      templateAuthority: sampleTemplateAuthority,
      resolveWorkflowMcpStageContract,
      workflowMcpEndpoint,
      t3: {
        registerWorkflowMcpProviderSession,
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
    expect(memory.record.state.handoffs[0]).toMatchObject({
      renderedHandoffAuthentication: {
        driver: "cursor",
        format: "heddle.handoff-authentication-binding",
        policy: "external-provider-session-v1",
        version: 1,
      },
    });
  });

  it("rejects a cold retry whose selected T3 driver changes before any second bootstrap effect", async () => {
    const memory = memoryStore();
    const ensureWorktree = vi.fn(async ({ branch }) => ({
      branch,
      created: false,
      path: "/workspaces/worktrees/sample-repository/task-prepare",
    }));
    const mintCorrelationToken = vi.fn(() => "correlation-token");
    const nextId = vi.fn(() => "stable-id");
    const applyHarnessToolTimeout = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => {
      throw new Error("stop after durable render");
    });
    const dependencies: SessionBootstrapDependencies = {
      persistence: memory.store,
      instantiateTodoList,
      templateAuthority: sampleTemplateAuthority,
      resolveWorkflowMcpStageContract,
      ensureWorktree,
      mintCorrelationToken,
      nextId,
      workflowMcpEndpoint,
      t3: {
        registerWorkflowMcpProviderSession,
        applyHarnessToolTimeout,
        dispatch,
      },
    };

    await expect(bootstrapStageSession(input, dependencies)).rejects.toThrow(
      /stop after durable render/,
    );
    expect(memory.record.state.handoffs[0]).toMatchObject({
      renderedHandoffAuthentication: { driver: "cursor" },
    });
    const persistedVersion = memory.record.version;
    const worktreeCount = ensureWorktree.mock.calls.length;
    const mintCount = mintCorrelationToken.mock.calls.length;
    const nextIdCount = nextId.mock.calls.length;
    const timeoutCount = applyHarnessToolTimeout.mock.calls.length;
    const dispatchCount = dispatch.mock.calls.length;

    const error = await bootstrapStageSession(
      {
        ...input,
        modelSelection: { ...input.modelSelection, instanceId: "claudeAgent" },
        providerContext: { ...input.providerContext, driver: "cursor" },
      },
      dependencies,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HandoffRenderError);
    expect(ensureWorktree).toHaveBeenCalledTimes(worktreeCount);
    expect(mintCorrelationToken).toHaveBeenCalledTimes(mintCount);
    expect(nextId).toHaveBeenCalledTimes(nextIdCount);
    expect(applyHarnessToolTimeout).toHaveBeenCalledTimes(timeoutCount);
    expect(dispatch).toHaveBeenCalledTimes(dispatchCount);
    expect(memory.record.version).toBe(persistedVersion);
    expect(memory.record.state.handoffs).toHaveLength(1);
  });

  it("rejects a cold retry when the stored prompt and rendered document disagree", async () => {
    const memory = memoryStore();
    const applyHarnessToolTimeout = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => {
      throw new Error("stop after durable render");
    });
    const dependencies: SessionBootstrapDependencies = {
      ensureWorktree: async ({ branch }) => ({
        branch,
        created: false,
        path: "/workspaces/worktrees/sample-repository/task-prepare",
      }),
      instantiateTodoList,
      mintCorrelationToken: () => "correlation-token",
      nextId: () => "stable-id",
      persistence: memory.store,
      templateAuthority: sampleTemplateAuthority,
      resolveWorkflowMcpStageContract,
      workflowMcpEndpoint,
      t3: {
        registerWorkflowMcpProviderSession,
        applyHarnessToolTimeout,
        dispatch,
      },
    };

    await expect(bootstrapStageSession(input, dependencies)).rejects.toThrow(
      "stop after durable render",
    );
    const persisted = memory.record;
    memory.store.compareAndSwapInstance(
      persisted.instanceId,
      persisted.version,
      {
        ...persisted.state,
        handoffs: persisted.state.handoffs.map((handoff) => ({
          ...(handoff as Record<string, unknown>),
          systemPrompt: "# Changed guidance",
        })),
      },
    );
    const timeoutCount = applyHarnessToolTimeout.mock.calls.length;
    const dispatchCount = dispatch.mock.calls.length;

    await expect(bootstrapStageSession(input, dependencies)).rejects.toThrow(
      "Stored rendered handoff does not match its system prompt",
    );
    expect(applyHarnessToolTimeout).toHaveBeenCalledTimes(timeoutCount);
    expect(dispatch).toHaveBeenCalledTimes(dispatchCount);
  });

  it.each(["claudeAgent", "sample-driver"])(
    "rejects a cold retry under changed driver %s before timeout or T3 dispatch",
    async (driver) => {
      const memory = memoryStore();
      const applyHarnessToolTimeout = vi.fn(async () => undefined);
      const dispatch = vi.fn(async () => {
        throw new Error("stop after durable render");
      });
      const dependencies: SessionBootstrapDependencies = {
        persistence: memory.store,
        instantiateTodoList,
        templateAuthority: sampleTemplateAuthority,
        resolveWorkflowMcpStageContract,
        workflowMcpEndpoint,
        t3: {
          registerWorkflowMcpProviderSession,
          applyHarnessToolTimeout,
          dispatch,
        },
        ensureWorktree: async ({ branch }) => ({
          branch,
          created: false,
          path: "/workspaces/worktrees/sample-repository/task-prepare",
        }),
        mintCorrelationToken: () => "correlation-token",
        nextId: () => "stable-id",
      };

      await expect(bootstrapStageSession(input, dependencies)).rejects.toThrow(
        /stop after durable render/,
      );
      expect(memory.record.state.handoffs[0]).toMatchObject({
        renderedHandoffAuthentication: { driver: "cursor" },
      });
      const timeoutCount = applyHarnessToolTimeout.mock.calls.length;
      const dispatchCount = dispatch.mock.calls.length;

      await expect(
        bootstrapStageSession(
          {
            ...input,
            modelSelection: { ...input.modelSelection, instanceId: driver },
            providerContext: {
              ...input.providerContext,
              driver,
              providerInstanceId: driver,
            },
          },
          dependencies,
        ),
      ).rejects.toThrow(/authentication binding is incompatible/);
      expect(applyHarnessToolTimeout).toHaveBeenCalledTimes(timeoutCount);
      expect(dispatch).toHaveBeenCalledTimes(dispatchCount);
    },
  );

  it("rejects a cold retry when the stored authentication policy differs before timeout or T3 dispatch", async () => {
    const memory = memoryStore();
    const applyHarnessToolTimeout = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => {
      throw new Error("stop after durable render");
    });
    const dependencies: SessionBootstrapDependencies = {
      persistence: memory.store,
      instantiateTodoList,
      templateAuthority: sampleTemplateAuthority,
      resolveWorkflowMcpStageContract,
      workflowMcpEndpoint,
      t3: {
        registerWorkflowMcpProviderSession,
        applyHarnessToolTimeout,
        dispatch,
      },
      ensureWorktree: async ({ branch }) => ({
        branch,
        created: false,
        path: "/workspaces/worktrees/sample-repository/task-prepare",
      }),
      mintCorrelationToken: () => "correlation-token",
      nextId: () => "stable-id",
    };

    await expect(bootstrapStageSession(input, dependencies)).rejects.toThrow(
      /stop after durable render/,
    );
    const persisted = memory.record;
    memory.store.compareAndSwapInstance(
      persisted.instanceId,
      persisted.version,
      {
        ...persisted.state,
        handoffs: persisted.state.handoffs.map((handoff) => ({
          ...(handoff as Record<string, unknown>),
          renderedHandoffAuthentication: {
            driver: "cursor",
            format: "heddle.handoff-authentication-binding",
            policy: "correlation-token-header-v1",
            version: 1,
          },
        })),
      },
    );
    const timeoutCount = applyHarnessToolTimeout.mock.calls.length;
    const dispatchCount = dispatch.mock.calls.length;

    await expect(bootstrapStageSession(input, dependencies)).rejects.toThrow(
      /no valid authentication binding/,
    );
    expect(applyHarnessToolTimeout).toHaveBeenCalledTimes(timeoutCount);
    expect(dispatch).toHaveBeenCalledTimes(dispatchCount);
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
      listInstances: memory.store.listInstances,
    };

    const result = await bootstrapStageSession(input, {
      persistence,
      instantiateTodoList,
      templateAuthority: sampleTemplateAuthority,
      resolveWorkflowMcpStageContract,
      workflowMcpEndpoint,
      t3: {
        registerWorkflowMcpProviderSession,
        dispatch: async () => ({ sequence: 1 }),
      },
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
        templateAuthority: sampleTemplateAuthority,
        resolveWorkflowMcpStageContract,
        workflowMcpEndpoint,
        t3: { registerWorkflowMcpProviderSession, dispatch },
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
        templateAuthority: sampleTemplateAuthority,
        resolveWorkflowMcpStageContract,
        workflowMcpEndpoint,
        t3: { registerWorkflowMcpProviderSession, dispatch },
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

  it("rejects a stored MCP contract that uses the removed handoff blobHash field", async () => {
    const memory = memoryStore({
      ...initialState(),
      correlationTokens: { "prepare-1": "token-1" },
      handoffs: [
        {
          correlationToken: "token-1",
          handoff: "stored handoff",
          kind: "stage-handoff",
          sessionKey: "prepare-1",
          workflowMcp: {
            ...workflowMcp,
            handoffTemplate: {
              blobHash: "b".repeat(40),
              path: "handoff-templates/sample.md",
            },
          },
        },
      ],
    });
    const dispatch = vi.fn(async () => ({ sequence: 1 }));

    await expect(
      bootstrapStageSession(input, {
        persistence: memory.store,
        instantiateTodoList,
        templateAuthority: sampleTemplateAuthority,
        resolveWorkflowMcpStageContract,
        workflowMcpEndpoint,
        t3: { registerWorkflowMcpProviderSession, dispatch },
        ensureWorktree: async ({ branch }) => ({
          branch,
          created: false,
          path: "/workspaces/worktrees/sample-repository/task-prepare",
        }),
      }),
    ).rejects.toThrow(
      "uses removed handoff template field 'blobHash'; use 'commitSha'",
    );
    expect(dispatch).not.toHaveBeenCalled();
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
        templateAuthority: sampleTemplateAuthority,
        resolveWorkflowMcpStageContract,
        workflowMcpEndpoint,
        t3: { registerWorkflowMcpProviderSession, dispatch },
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

  it("fails closed when stored handoff skills differ from the MCP contract", async () => {
    const stored = JSON.parse(handoffDocument("token-1")) as {
      stage: { skills: string[] };
    };
    stored.stage.skills = ["different-skill"];
    const memory = memoryStore({
      ...initialState(),
      correlationTokens: { "prepare-1": "token-1" },
      handoffs: [
        {
          correlationToken: "token-1",
          handoff: JSON.stringify(stored),
          kind: "stage-handoff",
          sessionKey: "prepare-1",
          workflowMcp,
        },
      ],
    });
    const applyHarnessToolTimeout = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => ({ sequence: 1 }));

    await expect(
      bootstrapStageSession(input, {
        persistence: memory.store,
        instantiateTodoList,
        templateAuthority: sampleTemplateAuthority,
        resolveWorkflowMcpStageContract,
        workflowMcpEndpoint,
        t3: {
          applyHarnessToolTimeout,
          registerWorkflowMcpProviderSession,
          dispatch,
        },
        ensureWorktree: async ({ branch }) => ({
          branch,
          created: false,
          path: "/workspaces/worktrees/sample-repository/task-prepare",
        }),
      }),
    ).rejects.toThrow("Stored handoff and workflow MCP skills disagree");
    expect(applyHarnessToolTimeout).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
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
        templateAuthority: sampleTemplateAuthority,
        resolveWorkflowMcpStageContract,
        workflowMcpEndpoint,
        t3: { registerWorkflowMcpProviderSession, dispatch },
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
        templateAuthority: sampleTemplateAuthority,
        workflowMcpEndpoint,
        t3: { registerWorkflowMcpProviderSession, dispatch },
        ensureWorktree: async () => {
          throw new Error("worktree rejected");
        },
      }),
    ).rejects.toThrow(/worktree rejected/);
    expect(dispatch).not.toHaveBeenCalled();
    expect(memory.record.state).toEqual(initialState());
  });

  it("does not fall back to the product repository when template authority is absent", async () => {
    const memory = memoryStore();
    const dispatch = vi.fn(async () => ({ sequence: 1 }));
    const ensureWorktree = vi.fn(async () => {
      throw new Error("Product worktree must not be inspected");
    });

    await expect(
      bootstrapStageSession(input, {
        ensureWorktree,
        persistence: memory.store,
        workflowMcpEndpoint,
        t3: { registerWorkflowMcpProviderSession, dispatch },
      }),
    ).rejects.toThrow(
      "Stage session bootstrap requires one organization template authority",
    );
    expect(ensureWorktree).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(memory.record.state).toEqual(initialState());
  });
});
