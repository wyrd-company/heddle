// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  HarnessToolTimeoutLaunchInput,
  T3DispatchCommand,
  T3ProviderDispatchContext,
} from "../control-plane/index.js";
import type { ProductionConfiguration } from "./configuration.js";
import {
  createProductionComposition,
  type ProductionT3Client,
} from "./composition.js";

const execute = promisify(execFile);

class SyntheticT3 implements ProductionT3Client {
  readonly commands: T3DispatchCommand[] = [];
  readonly timeouts: HarnessToolTimeoutLaunchInput[] = [];
  readonly threads = new Set<string>();

  async applyHarnessToolTimeout(
    input: HarnessToolTimeoutLaunchInput,
  ): Promise<void> {
    this.timeouts.push(input);
  }

  async dispatch(
    command: T3DispatchCommand,
    _providerContext?: T3ProviderDispatchContext,
  ): Promise<{ sequence: number }> {
    this.commands.push(structuredClone(command));
    if (command.type === "thread.create" && command.threadId !== undefined) {
      this.threads.add(command.threadId);
    }
    return { sequence: this.commands.length };
  }

  async getShell() {
    return {
      threads: [...this.threads].map((id) => ({
        id,
        latestTurn: { state: "running" },
        session: { status: "running" },
      })),
    };
  }

  async getThread() {
    return { thread: { activities: [] } };
  }

  async respondToApproval() {
    return { sequence: 1 };
  }

  async respondToUserInput() {
    return { sequence: 1 };
  }
}

describe("production composition", () => {
  let root = "";

  afterEach(async () => {
    if (root) await rm(root, { force: true, recursive: true });
  });

  const prepare = async (): Promise<{
    configuration: ProductionConfiguration;
    taskId: number;
  }> => {
    root = await mkdtemp(join(tmpdir(), "heddle-production-"));
    const repositoryRoot = join(root, "sample-repository");
    const boardDirectory = join(root, "sample-board");
    const stateDirectory = join(root, "state");
    await mkdir(join(repositoryRoot, "blueprints"), { recursive: true });
    await mkdir(join(repositoryRoot, "todo-templates"), { recursive: true });
    await writeFile(
      join(repositoryRoot, "blueprints", "sample.json"),
      JSON.stringify({
        edges: [
          {
            condition: "result.output.dispositions.complete",
            description: "Complete the sample",
            disposition: "complete",
            source: "implement",
            target: "finalize",
          },
        ],
        nodes: [
          {
            id: "implement",
            tools: ["advance"],
            "todo-template": "sample-stage",
            uses: "wait",
          },
          { id: "finalize", uses: "finalize" },
        ],
      }),
    );
    await writeFile(
      join(repositoryRoot, "todo-templates", "sample-stage.json"),
      JSON.stringify({
        items: [{ id: "deliver", text: "Deliver the sample" }],
      }),
    );
    await execute("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: repositoryRoot,
    });
    await execute("git", ["add", "blueprints", "todo-templates"], {
      cwd: repositoryRoot,
    });
    await execute(
      "git",
      [
        "-c",
        "user.name=Fixture User",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Add sample lifecycle",
      ],
      { cwd: repositoryRoot },
    );
    await mkdir(join(boardDirectory, "tasks"), { recursive: true });
    await writeFile(
      join(boardDirectory, "config.yml"),
      `version: 11
board:
  name: Sample Board
tasks_dir: tasks
statuses:
  - name: backlog
  - name: todo
  - name: in-progress
  - name: uat
  - name: done
priorities:
  - low
  - medium
  - high
defaults:
  status: backlog
  priority: medium
  class: standard
claim_timeout: 1h
classes:
  - name: standard
tui:
  title_lines: 2
  age_thresholds: []
next_id: 1
`,
    );
    const created = await execute(
      "kanban-md",
      [
        "--dir",
        boardDirectory,
        "create",
        "Example Item",
        "--status",
        "todo",
        "--priority",
        "medium",
        "--tags",
        "lifecycle:sample",
        "--json",
      ],
      { cwd: root },
    );
    const taskId = (JSON.parse(created.stdout) as { id: number }).id;
    return {
      taskId,
      configuration: {
        boardDirectory,
        cadenceMilliseconds: 60_000,
        observationThresholds: {
          endedMilliseconds: 60_000,
          failedMilliseconds: 60_000,
          stalledMilliseconds: 60_000,
        },
        pacing: {
          defaultProvider: "codex",
          maxConcurrentSessions: 2,
          providerBudgets: {},
          subagents: { maxDepth: 1, maxFanOut: 1 },
          usageWindowHours: 5,
        },
        projectId: "workspace-project",
        pushover: {
          apiUrl: "https://notify.invalid/messages",
          applicationToken: "application-token",
          consoleBaseUrl: "https://console.invalid/",
          userKey: "operator-key",
        },
        repositoryRoot,
        session: {
          baseRef: "main",
          cliVersion: "0.91.0",
          driver: "codex",
          interactionMode: "default",
          model: "sample-model",
          repositoryName: "sample-repository",
          runtimeMode: "auto-accept-edits",
          skillPointer: "skill://sample",
          worktreesRoot: join(root, "worktrees"),
        },
        stageThresholds: { implement: 60_000 },
        stateDirectory,
        stopTimeoutMilliseconds: 1_000,
        t3: { accessToken: "access-token", baseUrl: "http://127.0.0.1:3999" },
      },
    };
  };

  it("starts one durable instance and one project-grouped titled session across restart", async () => {
    const { configuration, taskId } = await prepare();
    const firstT3 = new SyntheticT3();
    const transport = { send: vi.fn(async () => undefined) };
    const first = createProductionComposition({
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: transport,
      t3: firstT3,
    });
    await first.start();
    await first.scheduler.trigger();

    expect(first.persistence.listInstances()).toHaveLength(1);
    expect(first.persistence.listReconcilerRuntime()).toMatchObject([
      { state: "waiting", taskId },
    ]);
    const create = firstT3.commands.find(
      ({ type }) => type === "thread.create",
    );
    const turn = firstT3.commands.find(
      ({ type }) => type === "thread.turn.start",
    );
    expect(create).toMatchObject({
      projectId: "workspace-project",
      title: expect.stringContaining(`task-${taskId}`),
      type: "thread.create",
    });
    expect(turn).not.toHaveProperty("titleSeed");
    expect(firstT3.timeouts).toHaveLength(1);
    await first.close();

    const secondT3 = new SyntheticT3();
    const second = createProductionComposition({
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: transport,
      t3: secondT3,
    });
    await second.start();
    expect(second.persistence.listInstances()).toHaveLength(1);
    expect(secondT3.commands).toHaveLength(0);
    await second.close();
  });

  it("releases a full production WIP gate on a later serialized pass", async () => {
    const { configuration, taskId } = await prepare();
    configuration.pacing.maxConcurrentSessions = 1;
    const t3 = new SyntheticT3();
    const composition = createProductionComposition({
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });
    composition.persistence.writeReconcilerRuntime({
      boardStatus: "in-progress",
      instanceId: "task-999",
      provider: "codex",
      state: "running",
      taskId: 999,
    });
    await composition.start();
    expect(
      composition.persistence
        .listReconcilerRuntime()
        .find(({ taskId: value }) => value === taskId),
    ).toMatchObject({
      deferral: { reason: "work-in-progress-limit" },
      state: "deferred",
    });
    expect(t3.commands).toHaveLength(0);

    composition.persistence.writeReconcilerRuntime({
      boardStatus: "done",
      instanceId: "task-999",
      provider: "codex",
      state: "done",
      taskId: 999,
    });
    await composition.scheduler.trigger();
    expect(
      composition.persistence
        .listReconcilerRuntime()
        .find(({ taskId: value }) => value === taskId),
    ).toMatchObject({ state: "waiting" });
    expect(
      t3.commands.filter(({ type }) => type === "thread.create"),
    ).toHaveLength(1);
    await composition.close();
  });

  it("releases a closed provider window on a later serialized pass", async () => {
    const { configuration, taskId } = await prepare();
    configuration.pacing.providerBudgets = { codex: { usageLimit: 1 } };
    let used = 1;
    const t3 = new SyntheticT3();
    const composition = createProductionComposition({
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used, windowStartedAt: Date.now() }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });
    await composition.start();
    expect(
      composition.persistence
        .listReconcilerRuntime()
        .find(({ taskId: value }) => value === taskId),
    ).toMatchObject({
      deferral: { reason: "provider-usage-window" },
      state: "deferred",
    });
    used = 0;
    await composition.scheduler.trigger();
    expect(
      composition.persistence
        .listReconcilerRuntime()
        .find(({ taskId: value }) => value === taskId),
    ).toMatchObject({ state: "waiting" });
    await composition.close();
  });

  it("persists configured over-threshold attention and ignores under-threshold work", async () => {
    const { configuration, taskId } = await prepare();
    const composition = createProductionComposition({
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    });
    await composition.start();
    const runtime = composition.persistence
      .listReconcilerRuntime()
      .find(({ taskId: value }) => value === taskId)!;
    composition.persistence.writeReconcilerRuntime({
      ...runtime,
      stageEnteredAt: Date.now() - 120_000,
    });
    composition.persistence.writeReconcilerRuntime({
      boardStatus: "in-progress",
      instanceId: "task-998",
      stageEnteredAt: Date.now(),
      stageId: "implement",
      state: "waiting",
      taskId: 998,
    });
    await composition.scheduler.trigger();
    expect(composition.attention.list()).toMatchObject([
      { instanceId: `task-${taskId}`, kind: "stale-instance", taskId },
    ]);
    await composition.close();

    const restarted = createProductionComposition({
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    });
    expect(restarted.attention.list()).toHaveLength(1);
    await restarted.close();
  });

  it("preserves epic, blocked, absent-dependency, standalone, and write boundaries", async () => {
    const { configuration } = await prepare();
    configuration.pacing.maxConcurrentSessions = 10;
    const create = async (arguments_: string[]): Promise<number> => {
      const result = await execute(
        "kanban-md",
        [
          "--dir",
          configuration.boardDirectory,
          "create",
          ...arguments_,
          "--json",
        ],
        { cwd: root },
      );
      return (JSON.parse(result.stdout) as { id: number }).id;
    };
    const epicId = await create([
      "Sample Epic",
      "--status",
      "in-progress",
      "--tags",
      "type:epic",
    ]);
    await create([
      "Completed Child",
      "--status",
      "done",
      "--parent",
      String(epicId),
    ]);
    const uatId = await create([
      "Acceptance Child",
      "--status",
      "backlog",
      "--parent",
      String(epicId),
      "--tags",
      "uat",
    ]);
    const pausedEpicId = await create([
      "Paused Epic",
      "--status",
      "todo",
      "--tags",
      "type:epic",
    ]);
    const pausedChildId = await create([
      "Paused Child",
      "--status",
      "backlog",
      "--parent",
      String(pausedEpicId),
    ]);
    const blockedId = await create([
      "Blocked Item",
      "--status",
      "todo",
      "--tags",
      "lifecycle:sample",
    ]);
    await execute(
      "kanban-md",
      [
        "--dir",
        configuration.boardDirectory,
        "edit",
        String(blockedId),
        "--block",
        "Explicit fixture block",
      ],
      { cwd: root },
    );
    const missingDependencyId = await create([
      "Removed Dependency",
      "--status",
      "done",
    ]);
    const absentDependencyId = await create([
      "Independent Item",
      "--status",
      "todo",
      "--depends-on",
      String(missingDependencyId),
      "--tags",
      "lifecycle:sample",
    ]);
    await execute(
      "kanban-md",
      [
        "--dir",
        configuration.boardDirectory,
        "delete",
        String(missingDependencyId),
        "--yes",
      ],
      { cwd: root },
    );
    const composition = createProductionComposition({
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    });
    await composition.start();
    let board = await composition.board.readBoard();
    expect(board.find(({ id }) => id === epicId)?.status).toBe("uat");
    expect(board.find(({ id }) => id === uatId)?.status).toBe("todo");
    expect(board.find(({ id }) => id === pausedChildId)?.status).toBe(
      "backlog",
    );
    expect(
      composition.persistence
        .listReconcilerRuntime()
        .some(({ taskId }) => taskId === blockedId),
    ).toBe(false);
    expect(
      composition.persistence
        .listReconcilerRuntime()
        .some(({ taskId }) => taskId === absentDependencyId),
    ).toBe(true);
    await expect(
      composition.board.mirrorTaskStatus(epicId, "done"),
    ).rejects.toThrow(`task ${epicId} is an epic task`);
    await expect(
      composition.board.transitionEpicStatus(absentDependencyId, "done"),
    ).rejects.toThrow(`task ${absentDependencyId} is not an epic task`);

    await execute(
      "kanban-md",
      [
        "--dir",
        configuration.boardDirectory,
        "edit",
        String(uatId),
        "--status",
        "done",
      ],
      { cwd: root },
    );
    await composition.scheduler.trigger();
    board = await composition.board.readBoard();
    expect(board.find(({ id }) => id === epicId)?.status).toBe("done");
    await composition.close();
  });
});
