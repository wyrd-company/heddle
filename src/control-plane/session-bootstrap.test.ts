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
import { harnessToolTimeoutConfiguration } from "./harness-tool-timeout.js";

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
      resolveWorkflowMcpStageContract,
      t3: {
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
    expect(first.toolTimeoutConfiguration).toEqual({
      claudeCode: { environment: { MCP_TOOL_TIMEOUT: "100000000" } },
      codex: { mcp_servers: { heddle: { tool_timeout_sec: 100_000 } } },
    });
    expect(dependencies.mintCorrelationToken).toHaveBeenCalledOnce();
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
        t3: { dispatch },
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
      persistence,
      instantiateTodoList,
      resolveWorkflowMcpStageContract,
      t3: { dispatch: async () => ({ sequence: 1 }) },
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
        sessionKey: "prepare-1",
        workflowMcp: await resolveWorkflowMcpStageContract(),
      }),
    );
    persistence.close();
  });
});
