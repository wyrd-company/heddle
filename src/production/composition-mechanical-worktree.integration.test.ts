// ---
// relationships:
//   verifies: heddle
// ---

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildKanbanProjection } from "../console/index.js";
import { deliveryBlueprintFixture } from "../engine/lifecycle-blueprint.test-support.js";
import { readLifecycleContext } from "../engine/index.js";
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
    workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
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
  const templateCommitSha = await git(
    fixture.blueprintsRepositoryRoot,
    "rev-parse",
    "HEAD",
  );
  const blueprint = deliveryBlueprintFixture("standard-delivery");
  for (const node of blueprint.nodes) {
    if (node.uses !== "wait") continue;
    node.tools = ["advance"];
    node["todo-template"] = "sample-stage";
    node["handoff-template"] =
      node.handoff === "remediation"
        ? {
            commitSha: templateCommitSha,
            path: "handoff-templates/remediation.md",
          }
        : {
            commitSha: templateCommitSha,
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

const changeMechanicalBlueprint = async (
  fixture: ProductionFixture,
  change: (blueprint: Record<string, unknown>) => void,
): Promise<void> => {
  const path = join(
    fixture.blueprintsRepositoryRoot,
    "blueprints/mechanical.json",
  );
  const blueprint = JSON.parse(await readFile(path, "utf8")) as Record<
    string,
    unknown
  >;
  change(blueprint);
  await writeFile(path, `${JSON.stringify(blueprint, null, 2)}\n`);
  await execute("git", ["add", "blueprints/mechanical.json"], {
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
      "Change mechanical lifecycle fixture",
    ],
    { cwd: fixture.blueprintsRepositoryRoot },
  );
  await execute("git", ["push", "--quiet", "origin", "main"], {
    cwd: fixture.blueprintsRepositoryRoot,
  });
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

  it("completes standard delivery when review approves an unchanged task branch", async () => {
    const fixture = await prepareProductionEpicFixture();
    cleanup = fixture.cleanup;
    await installStandardDelivery(fixture);
    const composition = compose(fixture, new SyntheticT3());
    const instanceId = `task-${fixture.taskId}`;
    const repositoryRoot =
      fixture.configuration.products[0]!.repos[0]!.repositoryRoot;
    const baseBranch = `epic/${fixture.epicId}`;
    const taskBranch = `heddle/task-${fixture.taskId}`;
    const worktree = join(
      fixture.configuration.session.worktreesRoot!,
      String(fixture.taskId),
      "sample-repository",
    );

    await composition.start();
    expect(await git(repositoryRoot, "rev-parse", taskBranch)).toBe(
      await git(repositoryRoot, "rev-parse", baseBranch),
    );
    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId,
      operationId: advanceOperationId(`${instanceId}:implement:1`),
    });
    expect(await statusOf(fixture)).toBe("review");

    await composition.lifecycle.resume({
      disposition: "approve",
      instanceId,
      operationId: advanceOperationId(`${instanceId}:review:1`),
    });
    expect(await statusOf(fixture)).toBe("retrospective");
    expect(
      composition.attention
        .list()
        .filter(({ taskId }) => taskId === fixture.taskId),
    ).toEqual([]);

    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId,
      operationId: advanceOperationId(`${instanceId}:retrospective:1`),
    });
    await composition.scheduler.trigger();
    await composition.scheduler.trigger();

    expect(await statusOf(fixture)).toBe("done");
    expect(
      composition.attention
        .list()
        .filter(({ taskId }) => taskId === fixture.taskId),
    ).toEqual([]);
    await expect(stat(worktree)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      execute(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/heads/${taskBranch}`],
        { cwd: repositoryRoot },
      ),
    ).rejects.toThrow();
    const instance = composition.persistence.getInstance(instanceId);
    if (instance === undefined)
      throw new Error("Lifecycle instance is missing");
    const events = (
      await Promise.all(
        readLifecycleContext(instance).executionIds.map((executionId) =>
          composition.persistence.flowcraftHistory.replay(executionId),
        ),
      )
    ).flat();
    expect(events.filter(({ type }) => type === "node:error")).toEqual([]);
    await composition.close();
  }, 20_000);

  it("stops a mechanical lifecycle before effects and board writes when a declared status is absent", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    await useMechanicalLifecycle(fixture);
    const composition = compose(fixture, new SyntheticT3());
    const statusWrites = vi.spyOn(composition.board, "mirrorTaskStatus");
    const statuses = await composition.board.readBoardStatuses();
    vi.spyOn(composition.board, "readBoardStatuses").mockResolvedValue(
      statuses.filter((status) => status !== "in-progress"),
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
          'Blueprint board-statuses maps mechanical node use "prepare-worktree" to status "in-progress", which is absent from the board configuration',
        ),
        taskId: fixture.taskId,
      }),
    );
    await composition.close();
  });

  it.each([
    {
      diagnostic:
        'Blueprint board-statuses is missing mechanical node use "prepare-worktree"',
      mutate: (blueprint: Record<string, unknown>) => {
        delete (blueprint["board-statuses"] as Record<string, string>)[
          "prepare-worktree"
        ];
      },
      shape: "missing mechanical use",
    },
    {
      diagnostic:
        'Blueprint board-statuses names unknown mechanical node use "publish"',
      mutate: (blueprint: Record<string, unknown>) => {
        (blueprint["board-statuses"] as Record<string, string>)["publish"] =
          "done";
      },
      shape: "unknown mechanical use",
    },
  ])(
    "rejects a blueprint map with $shape before mechanical effects or board writes",
    async ({ diagnostic, mutate }) => {
      const fixture = await prepareProductionFixture();
      cleanup = fixture.cleanup;
      await useMechanicalLifecycle(fixture);
      await changeMechanicalBlueprint(fixture, mutate);
      const composition = compose(fixture, new SyntheticT3());
      const statusWrites = vi.spyOn(composition.board, "mirrorTaskStatus");

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
          message: expect.stringContaining(diagnostic),
          taskId: fixture.taskId,
        }),
      );
      await composition.close();
    },
  );

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

  it("retains the complete session binding when restart follows the first mechanical effect", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    await useMechanicalLifecycle(fixture);
    const firstT3 = new SyntheticT3();
    const first = compose(fixture, firstT3);
    vi.spyOn(first.board, "mirrorTaskStatus").mockRejectedValue(
      new Error("Injected crash after worktree preparation"),
    );

    await first.start();

    const worktreePath = join(
      fixture.configuration.session.worktreesRoot!,
      String(fixture.taskId),
      "sample-repository",
    );
    await expect(stat(join(worktreePath, ".git"))).resolves.toBeDefined();
    const original = first.persistence.listSessionRuntime()[0]!;
    expect(original.binding).toEqual({
      alias: "primary",
      candidatePosition: 1,
      driverKind: "codex",
      interactionMode: "default",
      modelSlug: "sample-model",
      observedCliVersion: "0.91.0",
      providerDisplayName: "Workbench Alpha",
      providerInstanceId: "codex",
      runtimeMode: "auto-accept-edits",
      sessionKey: `task-${fixture.taskId}:implement:1`,
      skippedCandidates: [],
      threadId: expect.any(String),
    });
    expect(
      firstT3.commands.filter(({ type }) => type !== "project.create"),
    ).toHaveLength(0);
    expect(first.attention.list()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attentionId: expect.stringContaining(
            "production:session-observation-failed",
          ),
        }),
      ]),
    );
    await first.close();

    fixture.configuration.pacing.defaultProvider = "provider-changed";
    fixture.configuration.providerAliases = {
      changed: {
        model: "model-changed",
        providerDisplayName: "Workbench Changed",
      },
    };
    fixture.configuration.session.defaultProviderAlias = "changed";
    fixture.configuration.session.defaultRuntimeMode = "full-access";
    fixture.configuration.session.interactionMode = "review";
    fixture.configuration.session.defaultSelection = {
      alias: "changed",
      driverKind: "claudeAgent",
      interactionMode: "review",
      model: {
        isCustom: true,
        name: "Model Changed",
        slug: "model-changed",
      },
      observedCliVersion: "9.9.9",
      providerDisplayName: "Workbench Changed",
      providerInstanceId: "provider-changed",
      runtimeMode: "full-access",
    };
    fixture.configuration.session.resolvedSelections = [
      fixture.configuration.session.defaultSelection,
    ];
    const restartedT3 = new SyntheticT3();
    const restarted = compose(fixture, restartedT3);

    await restarted.start();

    const { bindingState: _provisional, ...confirmed } = original;
    void _provisional;
    expect(restarted.persistence.listSessionRuntime()).toEqual([
      expect.objectContaining(confirmed),
    ]);
    expect(restarted.persistence.listSessionRuntime()[0]).not.toHaveProperty(
      "bindingState",
    );
    expect(restartedT3.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          interactionMode: "default",
          modelSelection: { instanceId: "codex", model: "sample-model" },
          runtimeMode: "auto-accept-edits",
          threadId: original.threadId,
          type: "thread.create",
        }),
      ]),
    );
    expect(restartedT3.providerContexts).toEqual(
      expect.arrayContaining([
        {
          cliVersion: "0.91.0",
          driver: "codex",
          lifecycle: "independent",
          providerInstanceId: "codex",
        },
      ]),
    );
    await restarted.close();
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

  it("resolves only the recovered mechanical transition failure after its successful retry", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    await useMechanicalLifecycle(fixture);
    fixture.configuration.cadenceMilliseconds = 750;
    await writeFile(
      fixture.configuration.session.worktreesRoot!,
      "not a directory",
    );
    const composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    });

    await composition.start();

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

    const transitionAttention = composition.attention
      .list()
      .find(({ taskId }) => taskId === fixture.taskId)!;
    const unrelatedAttentionId = `production:task-reconciliation-failed:task:${fixture.taskId}:task-${fixture.taskId}`;
    await composition.attention.raise({
      attentionId: unrelatedAttentionId,
      code: "task-reconciliation-failed",
      error: {
        cause: null,
        message: "Synthetic unrelated condition",
        name: "Error",
      },
      instanceId: `task-${fixture.taskId}`,
      kind: "production-error",
      message: "Synthetic unrelated condition",
      taskId: fixture.taskId,
    });
    await rm(fixture.configuration.session.worktreesRoot!);
    await mkdir(fixture.configuration.session.worktreesRoot!);

    await composition.scheduler.trigger();

    expect(
      composition.attention
        .list()
        .filter(
          ({ attentionId }) =>
            !attentionId.includes(":incident-execution-failed:"),
        )
        .map(({ attentionId }) => attentionId),
    ).toEqual([unrelatedAttentionId]);
    expect(
      composition.persistence
        .listReconcilerRuntime()
        .find(({ taskId }) => taskId === fixture.taskId),
    ).toMatchObject({ stageId: "implement", state: "waiting" });
    expect(
      composition.persistence.hasAttention(transitionAttention.attentionId),
    ).toBe(true);
    await composition.close();
  });
});
