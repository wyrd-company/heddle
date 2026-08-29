// ---
// relationships:
//   verifies: heddle
// ---

import { afterEach, describe, expect, it, vi } from "vitest";

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
    const { configuration, root } = await prepare();
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
