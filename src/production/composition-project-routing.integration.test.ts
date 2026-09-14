// ---
// relationships:
//   verifies: heddle
// ---

import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { advanceOperationId } from "../mcp-server/operations.js";
import { SqlitePersistence } from "../persistence/index.js";
import { createProductionComposition } from "./composition.js";
import {
  execute,
  prepareProductionEpicFixture,
  SyntheticT3,
} from "./composition.test-support.js";

class TerminalT3 extends SyntheticT3 {
  terminal = false;

  override async getShell() {
    return {
      projects: [...this.projects.values()],
      threads: [...this.threads].map((id) =>
        this.terminal
          ? {
              id,
              latestTurn: { state: "completed" },
              session: { status: "ready" },
            }
          : {
              id,
              latestTurn: { state: "running" },
              session: { status: "running" },
            },
      ),
    };
  }
}

describe("production project routing", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => cleanup?.());

  it("provisions an epic project and routes its child through the task-first worktree", async () => {
    const fixture = await prepareProductionEpicFixture();
    cleanup = fixture.cleanup;
    const secondRepositoryRoot = join(
      fixture.root,
      "tools",
      "second-repository",
    );
    await mkdir(secondRepositoryRoot, { recursive: true });
    await writeFile(
      join(secondRepositoryRoot, "README.md"),
      "# Second sample\n",
    );
    await execute("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: secondRepositoryRoot,
    });
    await execute("git", ["add", "README.md"], { cwd: secondRepositoryRoot });
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
        "Add second sample",
      ],
      { cwd: secondRepositoryRoot },
    );
    await execute(
      "kanban-md",
      [
        "--dir",
        fixture.configuration.boardDirectory,
        "edit",
        String(fixture.epicId),
        "--repos",
        "sample-repository,second-repository",
      ],
      { cwd: fixture.root },
    );
    const t3 = new SyntheticT3();
    const composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });

    await composition.start();

    const project = t3.commands.find(
      (command) =>
        command.type === "project.create" &&
        command.projectId !== fixture.configuration.adHocProject.projectId,
    );
    const thread = t3.commands.find(
      (command) =>
        command.type === "thread.create" &&
        command.title === `task-${fixture.taskId} · implement-1`,
    );
    expect(project).toMatchObject({
      title: `Sample Delivery - epic-${fixture.epicId}`,
      type: "project.create",
      workspaceRoot: `${fixture.configuration.session.worktreesRoot}/${fixture.epicId}`,
    });
    expect(thread).toMatchObject({
      projectId: project?.projectId,
      type: "thread.create",
      worktreePath: `${fixture.configuration.session.worktreesRoot}/${fixture.taskId}/sample-repository`,
    });
    expect(thread).not.toHaveProperty("titleSeed");
    const firstTurn = t3.commands.find(
      ({ type }) => type === "thread.turn.start",
    );
    const firstTurnText = (firstTurn?.["message"] as { text?: string })?.text;
    expect(firstTurnText).toContain('"sample-repository"');
    expect(firstTurnText).toContain('"second-repository"');
    for (const [repositoryName, repositoryRoot] of [
      ["sample-repository", fixture.repositoryRoot],
      ["second-repository", secondRepositoryRoot],
    ] as const) {
      await expect(
        stat(
          join(
            fixture.configuration.session.worktreesRoot!,
            String(fixture.epicId),
            repositoryName,
            ".git",
          ),
        ),
      ).resolves.toBeDefined();
      await expect(
        stat(
          join(
            fixture.configuration.session.worktreesRoot!,
            String(fixture.taskId),
            repositoryName,
            ".git",
          ),
        ),
      ).resolves.toBeDefined();
      const epicHead = (
        await execute("git", ["rev-parse", `epic/${fixture.epicId}`], {
          cwd: repositoryRoot,
        })
      ).stdout.trim();
      const taskHead = (
        await execute("git", ["rev-parse", `heddle/task-${fixture.taskId}`], {
          cwd: repositoryRoot,
        })
      ).stdout.trim();
      expect(taskHead).toBe(epicHead);
    }
    await composition.close();
  });

  it("retains a completed epic project while archiving its exact stage threads", async () => {
    const fixture = await prepareProductionEpicFixture();
    cleanup = fixture.cleanup;
    const t3 = new TerminalT3();
    const compose = () =>
      createProductionComposition({
        workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
        blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
        configuration: fixture.configuration,
        providerUsage: {
          readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
        },
        pushoverTransport: { send: vi.fn(async () => undefined) },
        t3,
      });
    const first = compose();

    await first.start();
    const project = t3.commands.find(
      (command) =>
        command.type === "project.create" &&
        command.projectId !== fixture.configuration.adHocProject.projectId,
    );
    if (project?.type !== "project.create") {
      throw new Error("Expected the epic project creation command");
    }

    await first.lifecycle.resume({
      disposition: "complete",
      instanceId: `task-${fixture.taskId}`,
      operationId: advanceOperationId(`task-${fixture.taskId}:implement:1`),
    });
    await first.scheduler.trigger();
    for (const status of ["uat", "done"]) {
      await execute(
        "kanban-md",
        [
          "--dir",
          fixture.configuration.boardDirectory,
          "edit",
          String(fixture.epicId),
          "--status",
          status,
          "--json",
        ],
        { cwd: fixture.root },
      );
    }

    t3.terminal = true;
    await first.scheduler.trigger();
    const stageSessions = first.persistence.listSessionRuntime();
    const stageThreadIds = stageSessions
      .map(({ threadId }) => threadId)
      .toSorted();
    const implementThreadId = stageSessions.find(
      ({ stageId }) => stageId === "implement",
    )!.threadId;
    expect(stageThreadIds).toHaveLength(2);
    expect(
      t3.commands
        .filter(({ type }) => type === "thread.archive")
        .map(({ threadId }) => threadId)
        .toSorted(),
    ).toEqual([implementThreadId]);
    expect(
      t3.commands.filter(({ type }) => type === "project.delete"),
    ).toHaveLength(0);
    expect(first.persistence.getEpicProject(fixture.epicId)).toMatchObject({
      projectId: project.projectId,
      state: "active",
    });

    await execute(
      "kanban-md",
      [
        "--dir",
        fixture.configuration.boardDirectory,
        "create",
        "Check sample labels",
        "--status",
        "todo",
        "--parent",
        String(fixture.epicId),
        "--tags",
        "lifecycle:sample",
        "--json",
      ],
      { cwd: fixture.root },
    );
    await first.scheduler.trigger();
    expect(
      t3.commands.filter(({ type }) => type === "thread.create"),
    ).toHaveLength(2);
    const commandCount = t3.commands.length;
    await first.close();

    const restarted = compose();
    await restarted.start();
    await restarted.scheduler.trigger();
    expect(restarted.persistence.getEpicProject(fixture.epicId)).toMatchObject({
      projectId: project.projectId,
      state: "active",
    });
    expect(
      restarted.persistence
        .listSessionRuntime()
        .map(({ threadId }) => threadId)
        .toSorted(),
    ).toEqual(stageThreadIds);
    expect(t3.commands).toHaveLength(commandCount);
    await restarted.close();
  }, 20_000);

  it("recovers an epic after preparation stops between two repositories", async () => {
    const fixture = await prepareProductionEpicFixture();
    cleanup = fixture.cleanup;
    const secondRepositoryRoot = join(
      fixture.root,
      "tools",
      "second-repository",
    );
    await execute(
      "kanban-md",
      [
        "--dir",
        fixture.configuration.boardDirectory,
        "edit",
        String(fixture.epicId),
        "--repos",
        "sample-repository,second-repository",
      ],
      { cwd: fixture.root },
    );
    const t3 = new SyntheticT3();
    const composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });

    await composition.start();

    const firstEpicWorktree = join(
      fixture.configuration.session.worktreesRoot!,
      String(fixture.epicId),
      "sample-repository",
    );
    await expect(stat(join(firstEpicWorktree, ".git"))).resolves.toBeDefined();
    expect(composition.attention.list()).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          `Repository 'second-repository' resolved to unavailable path '${secondRepositoryRoot}'`,
        ),
        taskId: fixture.epicId,
      }),
    );
    expect(
      composition.persistence.getEpicProject(fixture.epicId),
    ).toMatchObject({ state: "creating" });
    await composition.close();

    await mkdir(secondRepositoryRoot, { recursive: true });
    await writeFile(
      join(secondRepositoryRoot, "README.md"),
      "# Second sample\n",
    );
    await execute("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: secondRepositoryRoot,
    });
    await execute("git", ["add", "README.md"], { cwd: secondRepositoryRoot });
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
        "Add second sample",
      ],
      { cwd: secondRepositoryRoot },
    );

    const restarted = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });
    await restarted.start();

    for (const repositoryName of ["sample-repository", "second-repository"]) {
      await expect(
        stat(
          join(
            fixture.configuration.session.worktreesRoot!,
            String(fixture.epicId),
            repositoryName,
            ".git",
          ),
        ),
      ).resolves.toBeDefined();
      await expect(
        stat(
          join(
            fixture.configuration.session.worktreesRoot!,
            String(fixture.taskId),
            repositoryName,
            ".git",
          ),
        ),
      ).resolves.toBeDefined();
    }
    expect(restarted.persistence.getEpicProject(fixture.epicId)).toMatchObject({
      state: "active",
    });
    expect(
      restarted.attention
        .list()
        .filter(({ taskId }) => taskId === fixture.epicId),
    ).toEqual([]);
    await restarted.close();
  });

  it("raises concrete recovery attention for an active legacy epic without durable repository scope", async () => {
    const fixture = await prepareProductionEpicFixture();
    cleanup = fixture.cleanup;
    const persistence = new SqlitePersistence({
      stateDirectory: fixture.configuration.stateDirectory,
    });
    persistence.writeEpicProject({
      createCommandId: "create-retained-project",
      createdAt: "2026-01-01T00:00:00.000Z",
      deleteCommandId: "delete-retained-project",
      epicId: fixture.epicId,
      productName: "Retained sample",
      projectId: "retained-project",
      repositoryNames: ["sample-repository"],
      state: "active",
    });
    const database = new Database(persistence.databasePath);
    database
      .prepare(
        "UPDATE heddle_epic_projects SET repository_names_json = NULL WHERE epic_id = ?",
      )
      .run(fixture.epicId);
    database.close();
    persistence.close();
    const t3 = new SyntheticT3();
    const composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });

    await composition.start();

    expect(composition.attention.list()).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          `Epic ${fixture.epicId} has no durable repository scope; operator recovery is required`,
        ),
        taskId: fixture.epicId,
      }),
    );
    expect(
      t3.commands.filter(({ type }) => type === "thread.create"),
    ).toHaveLength(0);
    await composition.close();
  });

  it("turns an unrouted epic into attention without freezing the scheduler", async () => {
    const fixture = await prepareProductionEpicFixture();
    cleanup = fixture.cleanup;
    await execute(
      "kanban-md",
      [
        "--dir",
        fixture.configuration.boardDirectory,
        "edit",
        String(fixture.epicId),
        "--clear-repos",
      ],
      { cwd: fixture.root },
    );
    const t3 = new SyntheticT3();
    const composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });

    await composition.start();

    expect(composition.attention.list()).toContainEqual(
      expect.objectContaining({
        kind: "production-error",
        message: expect.stringContaining(
          `Task ${fixture.epicId} does not declare repository scope in repos`,
        ),
        scope: `task:${fixture.epicId}`,
        taskId: fixture.epicId,
      }),
    );
    expect(
      t3.commands.filter(
        (command) =>
          command.type === "project.create" &&
          command.projectId !== fixture.configuration.adHocProject.projectId,
      ),
    ).toHaveLength(0);
    await composition.close();
  });
});
