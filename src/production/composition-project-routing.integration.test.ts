// ---
// relationships:
//   verifies: heddle
// ---

import { stat } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { advanceOperationId } from "../mcp-server/operations.js";
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

    const project = t3.commands.find(({ type }) => type === "project.create");
    const thread = t3.commands.find(
      (command) =>
        command.type === "thread.create" &&
        command.title === `task-${fixture.taskId} · implement-1`,
    );
    expect(project).toMatchObject({
      title: `Sample product - epic-${fixture.epicId}`,
      type: "project.create",
      workspaceRoot: `${fixture.configuration.session.worktreesRoot}/${fixture.epicId}`,
    });
    expect(thread).toMatchObject({
      projectId: project?.projectId,
      type: "thread.create",
      worktreePath: `${fixture.configuration.session.worktreesRoot}/${fixture.taskId}/sample-repository`,
    });
    expect(thread).not.toHaveProperty("titleSeed");
    await expect(
      stat(
        join(
          fixture.configuration.session.worktreesRoot!,
          String(fixture.epicId),
          "sample-repository",
          ".git",
        ),
      ),
    ).resolves.toBeDefined();
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
    const project = t3.commands.find(({ type }) => type === "project.create");
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

  it("turns an unrouted epic into attention without freezing the scheduler", async () => {
    const fixture = await prepareProductionEpicFixture();
    cleanup = fixture.cleanup;
    fixture.configuration.products.push({
      name: "Secondary product",
      repos: [
        {
          name: "secondary-repository",
          repositoryRoot: fixture.blueprintsRepositoryRoot,
        },
      ],
    });
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
          `Task ${fixture.epicId} does not identify one configured product`,
        ),
        scope: `task:${fixture.epicId}`,
        taskId: fixture.epicId,
      }),
    );
    expect(
      t3.commands.filter(({ type }) => type === "project.create"),
    ).toHaveLength(0);
    await composition.close();
  });
});
