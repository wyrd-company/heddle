// ---
// relationships:
//   verifies: heddle
// ---

import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
