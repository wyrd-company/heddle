// ---
// relationships:
//   verifies: heddle
// ---

import { access, copyFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { cwd } from "node:process";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  composeSystemPrompt,
  renderStageHandoff,
} from "../control-plane/index.js";
import { isStoredHandoff } from "../control-plane/stored-stage-handoff.js";
import { writeDeliveryBlueprintFixture } from "../engine/lifecycle-blueprint.test-support.js";
import { isWorkflowMcpStageContract } from "../mcp-server/index.js";
import { createProductionComposition } from "./composition.js";
import {
  execute,
  prepareProductionFixture,
  SyntheticT3,
} from "./composition.test-support.js";

describe("production composition", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
  });

  const prepare = async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    return fixture;
  };

  it("pages one stalled-session attention through the durable production route", async () => {
    const fixture = await prepare();
    fixture.configuration.observationThresholds = {
      endedMilliseconds: 1,
      failedMilliseconds: 1,
      stalledMilliseconds: 1,
    };
    const deliveries = vi.fn(async () => undefined);
    const composition = createProductionComposition({
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: deliveries },
      t3: new SyntheticT3(),
    });

    await composition.start();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
    await composition.scheduler.trigger();
    await composition.scheduler.trigger();

    expect(deliveries).toHaveBeenCalledTimes(1);
    expect(deliveries.mock.calls[0]?.[0]).toMatchObject({
      message: expect.stringContaining("is stalled without lifecycle advance"),
      stableId: expect.any(String),
    });
    const stableId = deliveries.mock.calls[0]?.[0].stableId;
    if (typeof stableId !== "string") throw new Error("Page has no stable ID");
    expect(composition.persistence.effectCompleted("pushover", stableId)).toBe(
      true,
    );
    await composition.close();
  });

  it("activates standard delivery from the organization template authority without product templates", async () => {
    const fixture = await prepare();
    const artifactPaths = [
      "handoff-templates/remediation.md",
      "handoff-templates/standard.md",
      "todo-templates/standard-delivery-implement.json",
      "todo-templates/standard-delivery-remediate.json",
      "todo-templates/standard-delivery-retrospective.json",
      "todo-templates/standard-delivery-review.json",
    ];
    await writeDeliveryBlueprintFixture(
      fixture.blueprintsRepositoryRoot,
      "standard-delivery",
    );
    for (const path of artifactPaths) {
      await copyFile(
        join(cwd(), path),
        join(fixture.blueprintsRepositoryRoot, path),
      );
    }
    await execute("git", ["add", "blueprints", ...artifactPaths], {
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
        "Add standard delivery artifacts",
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
    await expect(
      access(join(fixture.repositoryRoot, "handoff-templates")),
    ).rejects.toThrow();
    await expect(
      access(join(fixture.repositoryRoot, "todo-templates")),
    ).rejects.toThrow();

    const t3 = new SyntheticT3();
    const composition = createProductionComposition({
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });
    await composition.start();

    const instanceId = `task-${fixture.taskId}`;
    const record = composition.persistence.getInstance(instanceId)!;
    const stored = record.state.handoffs.find(isStoredHandoff);
    if (
      stored === undefined ||
      typeof stored.systemPrompt !== "string" ||
      !isWorkflowMcpStageContract(stored.workflowMcp)
    ) {
      throw new Error("Standard delivery activation has no stored handoff");
    }
    const pinnedBlob = await execute(
      "git",
      ["cat-file", "blob", stored.workflowMcp.handoffTemplate.blobHash],
      { cwd: fixture.blueprintsRepositoryRoot },
    );
    const expectedTemplateBytes = await readFile(
      join(cwd(), "handoff-templates/standard.md"),
      "utf8",
    );
    expect(pinnedBlob.stdout).toBe(expectedTemplateBytes);
    const bodyBoundary = expectedTemplateBytes.indexOf("\n---\n", 4);
    expect(bodyBoundary).toBeGreaterThan(0);
    const template = {
      ...stored.workflowMcp.handoffTemplate,
      body: expectedTemplateBytes.slice(bodyBoundary + "\n---\n".length),
      kind: "standard" as const,
    };
    const task = await composition.board.readTask(fixture.taskId);
    const expectedHandoff = renderStageHandoff({
      correlationToken: stored.correlationToken,
      driver: "codex",
      handoff: stored.handoff,
      instanceId,
      sessionKey: stored.sessionKey,
      stage: "implement",
      task: task.frontMatter,
      taskId: fixture.taskId,
      template,
    });
    const turn = t3.commands.find(({ type }) => type === "thread.turn.start");
    expect((turn?.["message"] as { text?: string }).text).toBe(
      composeSystemPrompt(
        stored.systemPrompt,
        expectedHandoff,
        stored.correlationToken,
      ),
    );
    await expect(
      execute(
        "git",
        ["cat-file", "-e", stored.workflowMcp.handoffTemplate.blobHash],
        { cwd: fixture.repositoryRoot },
      ),
    ).rejects.toThrow();
    await expect(
      execute(
        "git",
        [
          "rev-parse",
          `refs/heddle/handoff-templates/${stored.workflowMcp.handoffTemplate.blobHash}`,
        ],
        { cwd: fixture.blueprintsRepositoryRoot },
      ),
    ).resolves.toMatchObject({
      stdout: `${stored.workflowMcp.handoffTemplate.blobHash}\n`,
    });
    const productRefs = await execute(
      "git",
      ["for-each-ref", "--format=%(refname)", "refs/heddle/"],
      { cwd: fixture.repositoryRoot },
    );
    expect(productRefs.stdout).toBe("");
    expect(composition.persistence.listReconcilerRuntime()).toContainEqual(
      expect.objectContaining({
        instanceId,
        stageId: "implement",
        state: "waiting",
      }),
    );
    await composition.close();
  });

  it("releases a full production WIP gate on a later serialized pass", async () => {
    const { blueprintsRepositoryRoot, configuration, taskId } = await prepare();
    configuration.pacing.maxConcurrentSessions = 1;
    const t3 = new SyntheticT3();
    const composition = createProductionComposition({
      blueprintsRepositoryRoot,
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

  it("reports a scheduler-owned board failure as durable global attention", async () => {
    const fixture = await prepare();
    const onSchedulerError = vi.fn(async () => undefined);
    const composition = createProductionComposition({
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      onSchedulerError,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    });
    await rm(fixture.configuration.boardDirectory, {
      force: true,
      recursive: true,
    });

    await expect(composition.start()).rejects.toThrow();

    expect(onSchedulerError).toHaveBeenCalledOnce();
    expect(composition.attention.list()).toEqual([
      expect.objectContaining({
        kind: "production-error",
        message: expect.stringContaining(
          "Production reconciliation pass failed",
        ),
        scope: "all",
      }),
    ]);
    await composition.close().catch(() => undefined);
  });

  it("keeps scheduler dispatch moving after one task activation fails", async () => {
    const fixture = await prepare();
    const created = await execute(
      "kanban-md",
      [
        "--dir",
        fixture.configuration.boardDirectory,
        "create",
        "Secondary Item",
        "--status",
        "todo",
        "--tags",
        "lifecycle:sample",
        "--json",
      ],
      { cwd: fixture.root },
    );
    const secondTaskId = (JSON.parse(created.stdout) as { id: number }).id;
    class FirstTaskFailureT3 extends SyntheticT3 {
      override async dispatch(command: Parameters<SyntheticT3["dispatch"]>[0]) {
        if (
          command.type === "thread.create" &&
          command.title === `task-${fixture.taskId} · implement-1`
        ) {
          throw new Error("Injected first-task activation failure");
        }
        return super.dispatch(command);
      }
    }
    const composition = createProductionComposition({
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new FirstTaskFailureT3(),
    });

    await composition.start();

    expect(
      composition.persistence
        .listReconcilerRuntime()
        .find(({ taskId }) => taskId === secondTaskId),
    ).toMatchObject({ state: "waiting" });
    expect(composition.attention.list()).toEqual([
      expect.objectContaining({
        kind: "production-error",
        message: expect.stringContaining(
          "Injected first-task activation failure",
        ),
        scope: `task:${fixture.taskId}`,
        taskId: fixture.taskId,
      }),
    ]);
    await composition.close();
  });

  it("raises attention when a board task with a live instance disappears", async () => {
    const fixture = await prepare();
    fixture.configuration.cadenceMilliseconds = 750;
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
    await execute(
      "kanban-md",
      [
        "--dir",
        fixture.configuration.boardDirectory,
        "delete",
        String(fixture.taskId),
        "--yes",
      ],
      { cwd: fixture.root },
    );

    await vi.waitFor(
      () => {
        expect(composition.attention.list()).toHaveLength(1);
      },
      { timeout: 3_000 },
    );

    expect(composition.attention.list()).toEqual([
      expect.objectContaining({
        instanceId: `task-${fixture.taskId}`,
        kind: "production-error",
        taskId: fixture.taskId,
      }),
    ]);
    await composition.close();
  });

  it("releases a closed provider window on a later serialized pass", async () => {
    const { blueprintsRepositoryRoot, configuration, taskId } = await prepare();
    configuration.pacing.providerBudgets = { codex: { usageLimit: 1 } };
    let used = 1;
    const t3 = new SyntheticT3();
    const composition = createProductionComposition({
      blueprintsRepositoryRoot,
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

  it("persists configured over-threshold attention", async () => {
    const { blueprintsRepositoryRoot, configuration, taskId } = await prepare();
    const composition = createProductionComposition({
      blueprintsRepositoryRoot,
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
    await composition.scheduler.trigger();
    expect(composition.attention.list()).toContainEqual(
      expect.objectContaining({
        instanceId: `task-${taskId}`,
        kind: "stale-instance",
        taskId,
      }),
    );
    await composition.close();

    const restarted = createProductionComposition({
      blueprintsRepositoryRoot,
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
    const { blueprintsRepositoryRoot, configuration, root } = await prepare();
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
      blueprintsRepositoryRoot,
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
