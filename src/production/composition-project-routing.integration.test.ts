// ---
// relationships:
//   verifies: heddle
// ---

import { stat } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createProductionComposition } from "./composition.js";
import {
  prepareProductionEpicFixture,
  SyntheticT3,
} from "./composition.test-support.js";

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
