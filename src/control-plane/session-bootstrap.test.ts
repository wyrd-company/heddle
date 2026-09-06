// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwd } from "node:process";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SqlitePersistence,
  type InstanceRecord,
  type InstanceState,
} from "../persistence/index.js";
import {
  bootstrapStageSession,
  steerStageSession,
  type SessionBootstrapDependencies,
} from "./session-bootstrap.js";
import {
  harnessToolTimeoutConfiguration,
  harnessToolTimeoutLaunchConfiguration,
} from "./harness-tool-timeout.js";
import { builtInSystemPrompt } from "./system-prompt.js";
import {
  sampleHandoffTemplate,
  sampleTemplateAuthority,
} from "./session-bootstrap.test-support.js";
import { measuredMcpDrivers } from "./handoff-renderer.js";

const initialState = (): InstanceState => ({
  correlationTokens: {},
  flowcraftContext: null,
  handoffs: [],
  todoState: null,
});

const resolveWorkflowMcpStageContract = async () => ({
  blueprintBlobHash: "a".repeat(40),
  blueprintPath: "blueprints/sample-process.json",
  dispositions: [{ description: "Finish the preparation", name: "complete" }],
  handoffTemplate: sampleHandoffTemplate,
  skills: [],
  stage: "prepare",
  todoTemplate: "sample-prepare",
  tools: ["advance", "get_task_context"],
});

const instantiateTodoList: NonNullable<
  SessionBootstrapDependencies["instantiateTodoList"]
> = async ({ sessionKey, stage, taskContract, templateId }) => ({
  items: [
    {
      checked: false,
      id: "orient",
      text: `Orient on ${(taskContract as { title: string }).title}`,
    },
  ],
  sessionKey,
  stage,
  template: templateId,
});

const scratchDirectories: string[] = [];
const registerWorkflowMcpProviderSession = async (): Promise<void> => undefined;
const workflowMcpEndpoint = "http://127.0.0.1:4774/mcp";
const measuredDriversWithoutToolTimeout = measuredMcpDrivers.filter(
  (driver) => driver !== "claudeAgent" && driver !== "codex",
);

afterEach(async () => {
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("stage session bootstrap", () => {
  it("keeps the documented harness timeout configuration executable", async () => {
    const documentedDesign = await readFile(
      join(cwd(), "docs/technical-designs/heddle.yml"),
      "utf8",
    );
    const configured = harnessToolTimeoutConfiguration();

    expect(documentedDesign).toContain(
      `tool_timeout_sec = ${configured.codex.mcp_servers.heddle.tool_timeout_sec}`,
    );
    expect(documentedDesign).toContain(
      `MCP_TOOL_TIMEOUT=${configured.claudeCode.environment.MCP_TOOL_TIMEOUT}`,
    );
  });

  it.each([
    {
      driver: "codex",
      expected: {
        mcp_servers: { heddle: { tool_timeout_sec: 100_000 } },
      },
    },
    {
      driver: "claudeAgent",
      expected: { environment: { MCP_TOOL_TIMEOUT: "100000000" } },
    },
  ])(
    "applies the $driver tool timeout before creating its T3 thread",
    async ({ driver, expected }) => {
      let record: InstanceRecord = {
        instanceId: "instance-launch",
        state: initialState(),
        version: 1,
      };
      const operations: string[] = [];
      const applyHarnessToolTimeout = vi.fn(async () => {
        operations.push("apply-tool-timeout");
      });
      const registerWorkflowMcpProviderSession = vi.fn(async () => {
        operations.push("register-workflow-mcp");
      });
      const dispatch = vi.fn(async ({ type }: { type: string }) => {
        operations.push(type);
        return { sequence: operations.length };
      });
      const ids = [
        "thread-launch",
        "create-launch",
        "turn-launch",
        "message-launch",
      ];

      const result = await bootstrapStageSession(
        {
          handoff: {
            skillPointer: "skill://prepare",
            stage: {
              kind: "standard",
              name: "prepare",
              priorStageOutputs: [],
            },
            taskContract: { title: "Prepare inventory" },
          },
          instanceId: "instance-launch",
          interactionMode: "default",
          modelSelection: { instanceId: driver, model: "default" },
          projectId: "project-launch",
          providerContext: {
            cliVersion: "test-version",
            driver,
            lifecycle: "independent",
          },
          runtimeMode: "default",
          sessionKey: "prepare-launch",
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
        },
        {
          ensureWorktree: async ({ branch }) => ({
            branch,
            created: true,
            path: "/workspaces/worktrees/sample-repository/task-prepare",
          }),
          instantiateTodoList,
          nextId: () => ids.shift()!,
          persistence: {
            getInstance: () => record,
            compareAndSwapInstance: (_id, version, state) => {
              if (version !== record.version) return undefined;
              record = { ...record, state, version: record.version + 1 };
              return record;
            },
          },
          templateAuthority: sampleTemplateAuthority,
          resolveWorkflowMcpStageContract,
          workflowMcpEndpoint,
          t3: {
            registerWorkflowMcpProviderSession,
            applyHarnessToolTimeout,
            dispatch,
          },
        },
      );

      expect(operations).toEqual([
        "apply-tool-timeout",
        "register-workflow-mcp",
        "thread.create",
        "thread.turn.start",
      ]);
      expect(applyHarnessToolTimeout).toHaveBeenCalledWith({
        configuration: expected,
        driver,
        sessionKey: "prepare-launch",
        threadId: "thread-launch",
        worktreePath: "/workspaces/worktrees/sample-repository/task-prepare",
      });
      expect(result).not.toHaveProperty("toolTimeoutConfiguration");
      expect(registerWorkflowMcpProviderSession).toHaveBeenCalledWith({
        authorizationHeader: expect.stringMatching(/^Bearer \S+$/),
        endpoint: workflowMcpEndpoint,
        threadId: "thread-launch",
      });
    },
  );

  it.each(measuredDriversWithoutToolTimeout)(
    "registers workflow MCP for %s without applying a harness timeout",
    async (driver) => {
      let record: InstanceRecord = {
        instanceId: "instance-registration",
        state: initialState(),
        version: 1,
      };
      const operations: string[] = [];
      const registerWorkflowMcpProviderSession = vi.fn(async () => {
        operations.push("register-workflow-mcp");
      });
      const dispatch = vi.fn(async ({ type }: { type: string }) => {
        operations.push(type);
        return { sequence: operations.length };
      });

      await bootstrapStageSession(
        {
          handoff: {
            skillPointer: "skill://prepare",
            stage: {
              kind: "standard",
              name: "prepare",
              priorStageOutputs: [],
            },
            taskContract: { title: "Prepare inventory" },
          },
          instanceId: "instance-registration",
          interactionMode: "default",
          modelSelection: { instanceId: driver, model: "default" },
          projectId: "project-registration",
          providerContext: {
            cliVersion: "test-version",
            driver,
            lifecycle: "independent",
          },
          runtimeMode: "default",
          sessionKey: "prepare-registration",
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
        },
        {
          ensureWorktree: async ({ branch }) => ({
            branch,
            created: true,
            path: "/workspaces/worktrees/sample-repository/task-prepare",
          }),
          instantiateTodoList,
          mintCorrelationToken: () => "registration-token",
          persistence: {
            getInstance: () => record,
            compareAndSwapInstance: (_id, version, state) => {
              if (version !== record.version) return undefined;
              record = { ...record, state, version: record.version + 1 };
              return record;
            },
          },
          templateAuthority: sampleTemplateAuthority,
          resolveWorkflowMcpStageContract,
          t3: { dispatch, registerWorkflowMcpProviderSession },
          workflowMcpEndpoint,
        },
      );

      expect(operations).toEqual([
        "register-workflow-mcp",
        "thread.create",
        "thread.turn.start",
      ]);
      expect(registerWorkflowMcpProviderSession).toHaveBeenCalledWith({
        authorizationHeader: "Bearer registration-token",
        endpoint: workflowMcpEndpoint,
        threadId: expect.any(String),
      });
    },
  );

  it("stops before thread creation when workflow MCP registration fails", async () => {
    let record: InstanceRecord = {
      instanceId: "instance-registration-failure",
      state: initialState(),
      version: 1,
    };
    const dispatch = vi.fn(async () => ({ sequence: 1 }));
    const registerWorkflowMcpProviderSession = vi.fn(async () => {
      throw new Error("synthetic registration rejection");
    });

    await expect(
      bootstrapStageSession(
        {
          handoff: {
            skillPointer: "skill://prepare",
            stage: {
              kind: "standard",
              name: "prepare",
              priorStageOutputs: [],
            },
            taskContract: { title: "Prepare inventory" },
          },
          instanceId: "instance-registration-failure",
          interactionMode: "default",
          modelSelection: { instanceId: "cursor", model: "default" },
          projectId: "project-registration-failure",
          providerContext: {
            cliVersion: "test-version",
            driver: "cursor",
            lifecycle: "independent",
          },
          runtimeMode: "default",
          sessionKey: "prepare-registration-failure",
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
        },
        {
          ensureWorktree: async ({ branch }) => ({
            branch,
            created: true,
            path: "/workspaces/worktrees/sample-repository/task-prepare",
          }),
          instantiateTodoList,
          mintCorrelationToken: () => "registration-token",
          persistence: {
            getInstance: () => record,
            compareAndSwapInstance: (_id, version, state) => {
              if (version !== record.version) return undefined;
              record = { ...record, state, version: record.version + 1 };
              return record;
            },
          },
          templateAuthority: sampleTemplateAuthority,
          resolveWorkflowMcpStageContract,
          t3: { dispatch, registerWorkflowMcpProviderSession },
          workflowMcpEndpoint,
        },
      ),
    ).rejects.toThrow("synthetic registration rejection");
    expect(registerWorkflowMcpProviderSession).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects an unmeasured driver before worktree or T3 effects", async () => {
    const ensureWorktree = vi.fn();
    const dispatch = vi.fn();
    const registerWorkflowMcpProviderSession = vi.fn();

    await expect(
      bootstrapStageSession(
        {
          handoff: {
            skillPointer: "skill://prepare",
            stage: {
              kind: "standard",
              name: "prepare",
              priorStageOutputs: [],
            },
            taskContract: { title: "Prepare inventory" },
          },
          instanceId: "instance-unmeasured",
          interactionMode: "default",
          modelSelection: { instanceId: "sample-driver", model: "default" },
          projectId: "project-unmeasured",
          providerContext: {
            cliVersion: "test-version",
            driver: "sample-driver",
            lifecycle: "independent",
          },
          runtimeMode: "default",
          sessionKey: "prepare-unmeasured",
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
        },
        {
          ensureWorktree,
          persistence: {
            compareAndSwapInstance: vi.fn(),
            getInstance: vi.fn(),
            listInstances: vi.fn(),
          },
          t3: { dispatch, registerWorkflowMcpProviderSession },
          workflowMcpEndpoint,
        },
      ),
    ).rejects.toThrow("has no measured Heddle MCP authentication policy");
    expect(ensureWorktree).not.toHaveBeenCalled();
    expect(registerWorkflowMcpProviderSession).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "non-HTTP",
      "file:///tmp/sample-mcp",
      "workflowMcpEndpoint must be an HTTP(S) URL",
    ],
    ["malformed", "http://?", "workflowMcpEndpoint must be an HTTP(S) URL"],
    [
      "whitespace-bearing",
      " http://sample.invalid/mcp",
      "workflowMcpEndpoint must be an HTTP(S) URL",
    ],
    [
      "cleartext non-loopback",
      "http://192.0.2.10/mcp",
      "workflowMcpEndpoint must use HTTPS unless its hostname is loopback",
    ],
  ])(
    "rejects a %s workflow MCP endpoint before worktree or T3 effects",
    async (_kind, invalidEndpoint, expectedError) => {
      const ensureWorktree = vi.fn();
      const dispatch = vi.fn();
      const registerWorkflowMcpProviderSession = vi.fn();

      await expect(
        bootstrapStageSession(
          {
            handoff: {
              skillPointer: "skill://prepare",
              stage: {
                kind: "standard",
                name: "prepare",
                priorStageOutputs: [],
              },
              taskContract: { title: "Prepare inventory" },
            },
            instanceId: "instance-invalid-endpoint",
            interactionMode: "default",
            modelSelection: { instanceId: "cursor", model: "default" },
            projectId: "project-invalid-endpoint",
            providerContext: {
              cliVersion: "test-version",
              driver: "cursor",
              lifecycle: "independent",
            },
            runtimeMode: "default",
            sessionKey: "prepare-invalid-endpoint",
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
          },
          {
            ensureWorktree,
            persistence: {
              compareAndSwapInstance: vi.fn(),
              getInstance: vi.fn(),
              listInstances: vi.fn(),
            },
            t3: { dispatch, registerWorkflowMcpProviderSession },
            workflowMcpEndpoint: invalidEndpoint,
          },
        ),
      ).rejects.toThrow(expectedError);
      expect(ensureWorktree).not.toHaveBeenCalled();
      expect(registerWorkflowMcpProviderSession).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("rejects a driver without measured launch preparation", () => {
    expect(() =>
      harnessToolTimeoutLaunchConfiguration("sample-driver"),
    ).toThrow("Provider 'sample-driver' has no measured launch preparation");
  });

  it.each(["codex", "claudeAgent"])(
    "rejects $driver before thread creation without a timeout consumer",
    async (driver) => {
      let record: InstanceRecord = {
        instanceId: "instance-missing-consumer",
        state: initialState(),
        version: 1,
      };
      const dispatch = vi.fn(async () => ({ sequence: 1 }));

      await expect(
        bootstrapStageSession(
          {
            handoff: {
              skillPointer: "skill://prepare",
              stage: {
                kind: "standard",
                name: "prepare",
                priorStageOutputs: [],
              },
              taskContract: { title: "Prepare inventory" },
            },
            instanceId: "instance-missing-consumer",
            interactionMode: "default",
            modelSelection: { instanceId: driver, model: "default" },
            projectId: "project-missing-consumer",
            providerContext: {
              cliVersion: "test-version",
              driver,
              lifecycle: "independent",
            },
            runtimeMode: "default",
            sessionKey: "prepare-missing-consumer",
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
          },
          {
            ensureWorktree: async ({ branch }) => ({
              branch,
              created: true,
              path: "/workspaces/worktrees/sample-repository/task-prepare",
            }),
            instantiateTodoList,
            persistence: {
              getInstance: () => record,
              compareAndSwapInstance: (_id, version, state) => {
                if (version !== record.version) return undefined;
                record = { ...record, state, version: record.version + 1 };
                return record;
              },
            },
            templateAuthority: sampleTemplateAuthority,
            resolveWorkflowMcpStageContract,
            workflowMcpEndpoint,
            t3: { registerWorkflowMcpProviderSession, dispatch },
          },
        ),
      ).rejects.toThrow(/tool timeout application is required/);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("replays an identical persisted handoff into a fresh cold-retry session", async () => {
    let record: InstanceRecord = {
      instanceId: "instance-1",
      state: initialState(),
      version: 1,
    };
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
    const dependencies: SessionBootstrapDependencies = {
      persistence: {
        getInstance: () => record,
        compareAndSwapInstance: (_id, version, state) => {
          if (version !== record.version) return undefined;
          record = { ...record, state, version: record.version + 1 };
          return record;
        },
      },
      instantiateTodoList,
      templateAuthority: sampleTemplateAuthority,
      resolveWorkflowMcpStageContract,
      resolveSystemPrompt: vi
        .fn()
        .mockResolvedValueOnce("# Operator session guidance")
        .mockResolvedValueOnce("# Changed guidance"),
      workflowMcpEndpoint,
      t3: {
        registerWorkflowMcpProviderSession,
        dispatch: async (command) => {
          commands.push(command);
          return { sequence: commands.length };
        },
      },
      ensureWorktree: async ({ branch }) => ({
        branch,
        created: commands.length === 0,
        path: "/workspaces/worktrees/sample-repository/task-prepare",
      }),
      mintCorrelationToken: vi.fn(() => "correlation-token"),
      nextId: () => ids.shift()!,
      now: () => "2026-01-01T00:00:00.000Z",
    };
    const input = {
      handoff: {
        skillPointer: "skill://prepare",
        stage: {
          kind: "standard" as const,
          name: "prepare",
          priorStageOutputs: [],
        },
        taskContract: { title: "Prepare inventory" },
      },
      instanceId: "instance-1",
      interactionMode: "default",
      modelSelection: { instanceId: "cursor", model: "default" },
      projectId: "project-1",
      providerContext: {
        cliVersion: "2026.08.11-e8db854",
        driver: "cursor",
        lifecycle: "independent" as const,
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

    const first = await bootstrapStageSession(input, dependencies);
    const retry = await bootstrapStageSession(input, dependencies);
    const turnCommands = commands.filter(
      ({ type }) => type === "thread.turn.start",
    );

    expect(first.threadId).toBe("thread-1");
    expect(retry.threadId).toBe("thread-2");
    expect(retry.handoff).toBe(first.handoff);
    expect(first.systemPrompt).toBe("# Operator session guidance");
    expect(retry.systemPrompt).toBe(first.systemPrompt);
    expect(first.renderedHandoff).toContain("# Operator session guidance");
    expect(first.renderedHandoff).not.toContain(builtInSystemPrompt);
    expect(turnCommands).toHaveLength(2);
    expect(turnCommands[0]?.["threadId"]).toBe("thread-1");
    expect(turnCommands[1]?.["threadId"]).toBe("thread-2");
    expect((turnCommands[0]?.["message"] as { text: string }).text).toBe(
      (turnCommands[1]?.["message"] as { text: string }).text,
    );
    expect(turnCommands.every((command) => !("bootstrap" in command))).toBe(
      true,
    );
    expect(commands.map(({ type }) => type)).toEqual([
      "thread.create",
      "thread.turn.start",
      "thread.create",
      "thread.turn.start",
    ]);
    expect(record.state.correlationTokens).toEqual({
      "prepare-1": "correlation-token",
    });
    expect(record.state.handoffs).toHaveLength(1);
    expect(first.harnessConfiguration).toEqual({
      claudeCode: { permissions: { deny: ["TodoWrite"] } },
      codex: { tools: { update_plan: { enabled: false } } },
    });
    expect(dependencies.mintCorrelationToken).toHaveBeenCalledOnce();
    expect(dependencies.resolveSystemPrompt).toHaveBeenCalledOnce();
  });

  it("uses caller-pinned thread and command identities for delegated replay", async () => {
    let record: InstanceRecord = {
      instanceId: "instance-delegated",
      state: initialState(),
      version: 1,
    };
    const dispatch = vi.fn(async () => ({ sequence: 1 }));
    const input = {
      createdAt: "2026-01-01T00:00:00.000Z",
      handoff: {
        skillPointer: "skill://prepare",
        stage: {
          kind: "standard" as const,
          name: "prepare",
          priorStageOutputs: [],
        },
        taskContract: { title: "Prepare inventory" },
      },
      instanceId: "instance-delegated",
      interactionMode: "default",
      modelSelection: { instanceId: "cursor", model: "default" },
      projectId: "project-delegated",
      providerContext: {
        cliVersion: "sample-version",
        driver: "cursor",
        lifecycle: "independent" as const,
      },
      runtimeMode: "auto",
      sessionKey: "prepare-delegated",
      task: { id: 1, title: "Prepare inventory" },
      taskId: 1,
      threadCreateCommandId: "create-delegated",
      threadId: "thread-delegated",
      title: "Prepare inventory",
      turnCommandId: "turn-delegated",
      turnMessageId: "message-delegated",
      worktree: {
        baseRef: "main",
        branch: "task/prepare-delegated",
        repositoryName: "sample-repository",
        repositoryRoot: "/workspaces/sample-repository",
        worktreeName: "task-prepare-delegated",
      },
    };
    const dependencies: SessionBootstrapDependencies = {
      ensureWorktree: async ({ branch }) => ({
        branch,
        created: true,
        path: "/workspaces/worktrees/sample-repository/task-prepare-delegated",
      }),
      instantiateTodoList,
      mintCorrelationToken: () => "correlation-token",
      nextId: () => "unexpected-id",
      now: () => "unexpected-time",
      persistence: {
        compareAndSwapInstance: (_id, version, state) => {
          if (version !== record.version) return undefined;
          record = { ...record, state, version: record.version + 1 };
          return record;
        },
        getInstance: () => record,
      },
      templateAuthority: sampleTemplateAuthority,
      resolveWorkflowMcpStageContract,
      workflowMcpEndpoint,
      t3: { registerWorkflowMcpProviderSession, dispatch },
    };

    await bootstrapStageSession(input, dependencies);
    await bootstrapStageSession(input, dependencies);

    expect(dispatch.mock.calls.map(([command]) => command)).toEqual([
      expect.objectContaining({
        commandId: "create-delegated",
        createdAt: input.createdAt,
        threadId: "thread-delegated",
        type: "thread.create",
      }),
      expect.objectContaining({
        commandId: "turn-delegated",
        createdAt: input.createdAt,
        message: expect.objectContaining({ messageId: "message-delegated" }),
        threadId: "thread-delegated",
        type: "thread.turn.start",
      }),
      expect.objectContaining({ commandId: "create-delegated" }),
      expect.objectContaining({
        commandId: "turn-delegated",
        message: expect.objectContaining({ messageId: "message-delegated" }),
      }),
    ]);
  });

  it("replays the exact rendered payload after turn acceptance precedes activation recording", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "heddle-activation-"));
    scratchDirectories.push(stateDirectory);
    const persistence = new SqlitePersistence({ stateDirectory });
    persistence.createInstance("instance-activation", initialState());
    const commands: Record<string, unknown>[] = [];
    const input = {
      createdAt: "2026-01-01T00:00:00.000Z",
      handoff: {
        skillPointer: "skill://prepare",
        stage: {
          kind: "standard" as const,
          name: "prepare",
          priorStageOutputs: [],
        },
        taskContract: { id: 1, title: "Prepare inventory" },
      },
      instanceId: "instance-activation",
      interactionMode: "default",
      modelSelection: { instanceId: "cursor", model: "default" },
      projectId: "project-activation",
      providerContext: {
        cliVersion: "sample-version",
        driver: "cursor",
        lifecycle: "independent" as const,
      },
      runtimeMode: "auto",
      sessionKey: "prepare-activation",
      task: { id: 1, title: "Prepare inventory" },
      taskId: 1,
      threadCreateCommandId: "create-activation",
      threadId: "thread-activation",
      title: "Prepare inventory",
      turnCommandId: "turn-activation",
      turnMessageId: "message-activation",
      worktree: {
        baseRef: "main",
        branch: "task/prepare-activation",
        repositoryName: "sample-repository",
        repositoryRoot: "/workspaces/sample-repository",
        worktreeName: "task-prepare-activation",
      },
    };
    const resolveSystemPrompt = vi
      .fn()
      .mockResolvedValueOnce("# Original session guidance")
      .mockResolvedValueOnce("# Changed session guidance");
    const common = {
      ensureWorktree: async ({ branch }: { branch: string }) => ({
        branch,
        created: false,
        path: "/workspaces/worktrees/sample-repository/task-prepare-activation",
      }),
      instantiateTodoList,
      mintCorrelationToken: () => "correlation-token",
      persistence,
      templateAuthority: sampleTemplateAuthority,
      resolveWorkflowMcpStageContract,
      resolveSystemPrompt,
      workflowMcpEndpoint,
      t3: {
        registerWorkflowMcpProviderSession,
        dispatch: async (command: Record<string, unknown>) => {
          commands.push(command);
          return { sequence: commands.length };
        },
      },
    };

    await expect(
      bootstrapStageSession(input, {
        ...common,
        activationEvents: {
          appendEvent: () => {
            throw new Error("simulated crash before activation event");
          },
          replayEvents: (instanceId, afterSequence) =>
            persistence.replayEvents(instanceId, afterSequence),
        },
      }),
    ).rejects.toThrow("simulated crash before activation event");
    await bootstrapStageSession(input, {
      ...common,
      activationEvents: persistence,
    });

    const turns = commands.filter(({ type }) => type === "thread.turn.start");
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual(turns[1]);
    const activations = persistence
      .replayEvents(input.instanceId)
      .filter(({ type }) => type === "session:activated");
    expect(activations).toHaveLength(1);
    expect(activations[0]?.payload).toMatchObject({
      renderedDocument: (turns[0]?.["message"] as { text: string }).text,
      systemPrompt: "# Original session guidance",
    });
    expect(resolveSystemPrompt).toHaveBeenCalledOnce();
    persistence.close();
  });

  it("steers with a second bare turn on the existing thread", async () => {
    const dispatch = vi.fn(async () => ({ sequence: 1 }));

    await steerStageSession(
      {
        interactionMode: "default",
        message: "Use the smaller container.",
        providerContext: {
          cliVersion: "2026.08.11-e8db854",
          driver: "cursor",
          lifecycle: "independent",
        },
        runtimeMode: "auto",
        threadId: "thread-1",
      },
      {
        nextId: vi
          .fn()
          .mockReturnValueOnce("turn-2")
          .mockReturnValueOnce("message-2"),
        now: () => "2026-01-01T00:00:00.000Z",
        workflowMcpEndpoint,
        t3: { registerWorkflowMcpProviderSession, dispatch },
      },
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: "turn-2",
        threadId: "thread-1",
        type: "thread.turn.start",
      }),
      expect.objectContaining({ driver: "cursor" }),
    );
    expect(dispatch.mock.calls[0]?.[0]).not.toHaveProperty("bootstrap");
  });

  it("recovers the stored bootstrap from SQLite", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "heddle-handoff-"));
    scratchDirectories.push(stateDirectory);
    let persistence = new SqlitePersistence({ stateDirectory });
    persistence.createInstance("instance-1", initialState());
    const dependencies: SessionBootstrapDependencies = {
      activationEvents: persistence,
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
        created: true,
        path: "/workspaces/worktrees/sample-repository/task-prepare",
      }),
      mintCorrelationToken: () => "correlation-token",
      nextId: vi
        .fn()
        .mockReturnValueOnce("thread-1")
        .mockReturnValueOnce("create-1")
        .mockReturnValueOnce("turn-1")
        .mockReturnValueOnce("message-1"),
    };

    const result = await bootstrapStageSession(
      {
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
      },
      dependencies,
    );
    persistence.close();
    persistence = new SqlitePersistence({ stateDirectory });

    expect(
      persistence.getInstance("instance-1")?.state.handoffs,
    ).toContainEqual(
      expect.objectContaining({
        correlationToken: "correlation-token",
        handoff: result.handoff,
        kind: "stage-handoff",
        renderedHandoff: result.renderedHandoff,
        sessionKey: "prepare-1",
        workflowMcp: await resolveWorkflowMcpStageContract(),
      }),
    );
    expect(
      persistence
        .replayEvents("instance-1")
        .filter(({ type }) => type === "session:activated"),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          renderedDocument: result.renderedHandoff,
          systemPrompt: builtInSystemPrompt,
        }),
      }),
    ]);
    persistence.close();
  });
});
