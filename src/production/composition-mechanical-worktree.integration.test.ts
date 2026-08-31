// ---
// relationships:
//   verifies: heddle
// ---

import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildKanbanProjection } from "../console/index.js";
import { deliveryBlueprintFixture } from "../engine/lifecycle-blueprint.test-support.js";
import { advanceOperationId } from "../mcp-server/operations.js";
import { createProductionComposition } from "./composition.js";
import {
  execute,
  prepareProductionEpicFixture,
  prepareProductionFixture,
  SyntheticT3,
  useMechanicalLifecycle,
  type ProductionFixture,
} from "./composition.test-support.js";

const git = async (cwd: string, ...arguments_: string[]): Promise<string> =>
  (await execute("git", arguments_, { cwd })).stdout.trim();

const compose = (fixture: ProductionFixture, t3: SyntheticT3) =>
  createProductionComposition({
    blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
    configuration: fixture.configuration,
    providerUsage: {
      readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
    },
    pushoverTransport: { send: vi.fn(async () => undefined) },
    t3,
  });

const statusOf = async (
  fixture: ProductionFixture,
  taskId: number = fixture.taskId,
): Promise<string> => {
  const result = await execute(
    "kanban-md",
    [
      "--dir",
      fixture.configuration.boardDirectory,
      "show",
      String(taskId),
      "--json",
    ],
    { cwd: fixture.root },
  );
  return (JSON.parse(result.stdout) as { status: string }).status;
};

const installStandardDelivery = async (
  fixture: ProductionFixture,
): Promise<void> => {
  const standardHash = await git(
    fixture.blueprintsRepositoryRoot,
    "hash-object",
    "handoff-templates/standard.md",
  );
  const remediationHash = await git(
    fixture.blueprintsRepositoryRoot,
    "hash-object",
    "handoff-templates/remediation.md",
  );
  const blueprint = deliveryBlueprintFixture("standard-delivery");
  for (const node of blueprint.nodes) {
    if (node.uses !== "wait") continue;
    node.tools = ["advance"];
    node["todo-template"] = "sample-stage";
    node["handoff-template"] =
      node.handoff === "remediation"
        ? {
            blobHash: remediationHash,
            path: "handoff-templates/remediation.md",
          }
        : {
            blobHash: standardHash,
            path: "handoff-templates/standard.md",
          };
  }
  await writeFile(
    join(
      fixture.blueprintsRepositoryRoot,
      "blueprints",
      "standard-delivery.json",
    ),
    JSON.stringify({
      $schema: "https://wyrd.company/heddle/lifecycle-blueprint.schema.json",
      ...blueprint,
      relationships: {
        implements: "heddle",
        uses: ["remediation", "sample-stage", "standard"],
      },
    }),
  );
  await execute("git", ["add", "blueprints/standard-delivery.json"], {
    cwd: fixture.blueprintsRepositoryRoot,
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
      "Add standard delivery fixture",
    ],
    { cwd: fixture.blueprintsRepositoryRoot },
  );
  await execute("git", ["push", "--quiet", "origin", "main"], {
    cwd: fixture.blueprintsRepositoryRoot,
  });
  await execute(
    "kanban-md",
    [
      "--dir",
      fixture.configuration.boardDirectory,
      "edit",
      String(fixture.taskId),
      "--remove-tag",
      "lifecycle:sample",
      "--add-tag",
      "lifecycle:standard-delivery",
      "--json",
    ],
    { cwd: fixture.root },
  );
};

describe("production mechanical worktree preparation", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => cleanup?.());

  it("prepares the epic child task worktree from the epic branch at instance start", async () => {
    const fixture = await prepareProductionEpicFixture();
    cleanup = fixture.cleanup;
    await useMechanicalLifecycle(fixture);
    const repositoryRoot =
      fixture.configuration.products[0]!.repos[0]!.repositoryRoot;
    await git(
      repositoryRoot,
      "switch",
      "--quiet",
      "-c",
      `epic/${fixture.epicId}`,
    );
    await execute(
      "git",
      [
        "-c",
        "user.name=Fixture User",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "Advance the epic branch",
      ],
      { cwd: repositoryRoot },
    );
    await git(repositoryRoot, "switch", "--quiet", "main");
    const t3 = new SyntheticT3();
    const composition = compose(fixture, t3);

    await composition.start();

    const worktreePath = join(
      fixture.configuration.session.worktreesRoot!,
      String(fixture.taskId),
      "sample-repository",
    );
    await expect(stat(join(worktreePath, ".git"))).resolves.toBeDefined();
    expect(await git(worktreePath, "symbolic-ref", "--short", "HEAD")).toBe(
      `heddle/task-${fixture.taskId}`,
    );
    expect(
      await git(repositoryRoot, "rev-parse", `heddle/task-${fixture.taskId}`),
    ).toBe(await git(repositoryRoot, "rev-parse", `epic/${fixture.epicId}`));
    expect(
      await git(repositoryRoot, "rev-parse", `heddle/task-${fixture.taskId}`),
    ).not.toBe(await git(repositoryRoot, "rev-parse", "main"));
    expect(
      t3.commands.find(
        (command) =>
          command.type === "thread.create" &&
          command.title === `task-${fixture.taskId} · implement-1`,
      ),
    ).toBeDefined();
    const projection = buildKanbanProjection({
      instances: composition.persistence.listReconcilerRuntime(),
      now: Date.now(),
      scope: { kind: "all" },
      statuses: await composition.board.readBoardStatuses(),
      tasks: await composition.board.readBoard(),
    });
    expect(
      projection.columns
        .find(({ status }) => status === "in-progress")
        ?.tasks.find(({ id }) => id === fixture.taskId),
    ).toMatchObject({ stageId: "implement" });
    await composition.close();
  });

  it("mirrors standard delivery through board-declared columns without a runtime mirror race", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    await installStandardDelivery(fixture);
    const composition = compose(fixture, new SyntheticT3());
    const statusWrites = vi.spyOn(composition.board, "mirrorTaskStatus");

    await composition.start();
    expect(await statusOf(fixture)).toBe("in-progress");
    const worktree = join(
      fixture.configuration.session.worktreesRoot!,
      String(fixture.taskId),
      "sample-repository",
    );
    await writeFile(join(worktree, "delivery.txt"), "completed\n");
    await execute("git", ["add", "delivery.txt"], { cwd: worktree });
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
        "Complete delivery fixture",
      ],
      { cwd: worktree },
    );

    statusWrites.mockClear();
    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId: `task-${fixture.taskId}`,
      operationId: advanceOperationId(`task-${fixture.taskId}:implement:1`),
    });
    expect(await statusOf(fixture)).toBe("review");
    await composition.scheduler.trigger();
    expect(statusWrites).toHaveBeenCalledTimes(1);
    expect(await statusOf(fixture)).toBe("review");

    await composition.lifecycle.resume({
      disposition: "approve",
      instanceId: `task-${fixture.taskId}`,
      operationId: advanceOperationId(`task-${fixture.taskId}:review:1`),
    });
    expect(await statusOf(fixture)).toBe("retrospective");
    await composition.scheduler.trigger();
    expect(statusWrites).toHaveBeenCalledTimes(2);
    expect(await statusOf(fixture)).toBe("retrospective");

    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId: `task-${fixture.taskId}`,
      operationId: advanceOperationId(`task-${fixture.taskId}:retrospective:1`),
    });
    expect(await statusOf(fixture)).toBe("done");
    await composition.scheduler.trigger();
    expect(statusWrites).toHaveBeenCalledTimes(3);
    expect(await statusOf(fixture)).toBe("done");
    expect(statusWrites.mock.calls.map(([, status]) => status)).toEqual([
      "review",
      "retrospective",
      "done",
    ]);
    await composition.close();
  }, 20_000);

  it("stops a mechanical lifecycle before effects and board writes when a required delivery status is absent", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    await useMechanicalLifecycle(fixture);
    const composition = compose(fixture, new SyntheticT3());
    const statusWrites = vi.spyOn(composition.board, "mirrorTaskStatus");
    const statuses = await composition.board.readBoardStatuses();
    vi.spyOn(composition.board, "readBoardStatuses").mockResolvedValue(
      statuses.filter((status) => status !== "review"),
    );

    await composition.start();

    expect(statusWrites).not.toHaveBeenCalled();
    await expect(
      stat(
        join(
          fixture.configuration.session.worktreesRoot!,
          String(fixture.taskId),
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(composition.attention.list()).toContainEqual(
      expect.objectContaining({
        kind: "production-error",
        message: expect.stringContaining(
          "Board configuration is missing required mechanical status 'review'",
        ),
        taskId: fixture.taskId,
      }),
    );
    await composition.close();
  });

  it("prepares a parentless task worktree from the configured base ref at instance start", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    await useMechanicalLifecycle(fixture);
    const repositoryRoot =
      fixture.configuration.products[0]!.repos[0]!.repositoryRoot;
    const t3 = new SyntheticT3();
    const composition = compose(fixture, t3);

    await composition.start();

    const worktreePath = join(
      fixture.configuration.session.worktreesRoot!,
      String(fixture.taskId),
      "sample-repository",
    );
    await expect(stat(join(worktreePath, ".git"))).resolves.toBeDefined();
    expect(await git(worktreePath, "symbolic-ref", "--short", "HEAD")).toBe(
      `heddle/task-${fixture.taskId}`,
    );
    expect(
      await git(repositoryRoot, "rev-parse", `heddle/task-${fixture.taskId}`),
    ).toBe(await git(repositoryRoot, "rev-parse", "main"));
    expect(composition.attention.list()).toEqual([]);
    expect(
      composition.persistence
        .listReconcilerRuntime()
        .find(({ taskId }) => taskId === fixture.taskId),
    ).toMatchObject({ stageId: "implement", state: "waiting" });
    await composition.close();
  });

  it("raises routing attention and runs no mechanical node when a task targets more than one repository", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    await useMechanicalLifecycle(fixture);
    const repositoryRoot =
      fixture.configuration.products[0]!.repos[0]!.repositoryRoot;
    fixture.configuration.products[0]!.repos.push({
      name: "second-repository",
      repositoryRoot,
    });
    const t3 = new SyntheticT3();
    const composition = compose(fixture, t3);

    await composition.start();

    expect(composition.attention.list()).toMatchObject([
      {
        kind: "lifecycle-resolution",
        message: `Task ${fixture.taskId} targets more than one repository but its stage declares none`,
        taskId: fixture.taskId,
      },
    ]);
    expect(
      composition.persistence
        .listReconcilerRuntime()
        .find(({ taskId }) => taskId === fixture.taskId),
    ).toBeUndefined();
    expect(
      t3.commands.filter(({ type }) => type === "thread.create"),
    ).toHaveLength(0);
    await expect(
      stat(
        join(
          fixture.configuration.session.worktreesRoot!,
          String(fixture.taskId),
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await composition.close();
  });

  it("bridges a mechanical failure through the scheduler once across cadence passes", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    await useMechanicalLifecycle(fixture);
    fixture.configuration.cadenceMilliseconds = 750;
    await writeFile(
      fixture.configuration.session.worktreesRoot!,
      "not a directory",
    );
    const composition = createProductionComposition({
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    });

    await composition.start();
    const created = await execute(
      "kanban-md",
      [
        "--dir",
        fixture.configuration.boardDirectory,
        "create",
        "Additional Item",
        "--status",
        "todo",
        "--tags",
        "lifecycle:sample",
        "--json",
      ],
      { cwd: fixture.root },
    );
    const additionalTaskId = (JSON.parse(created.stdout) as { id: number }).id;
    await vi.waitFor(
      () => {
        expect(
          composition.persistence
            .listReconcilerRuntime()
            .some(({ taskId }) => taskId === additionalTaskId),
        ).toBe(true);
      },
      { timeout: 3_000 },
    );

    expect(
      composition.attention
        .list()
        .filter(({ taskId }) => taskId === fixture.taskId),
    ).toEqual([
      expect.objectContaining({
        attentionId: expect.stringContaining(
          `production:lifecycle-execution-failed:task:${fixture.taskId}:task-${fixture.taskId}`,
        ),
        instanceId: `task-${fixture.taskId}`,
        kind: "production-error",
        message: expect.stringMatching(
          /prepare-worktree|file already exists|EEXIST/i,
        ),
        taskId: fixture.taskId,
      }),
    ]);
    await composition.close();
  });
});
