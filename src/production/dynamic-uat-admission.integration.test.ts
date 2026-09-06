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

describe("production trusted dynamic work during UAT", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
  }, 15_000);

  it("admits exact authority from a mixed set and completes recursive growth without another UAT runtime", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    fixture.configuration.pacing.maxConcurrentSessions = 10;
    const command = (arguments_: string[]) =>
      execute(
        "kanban-md",
        ["--dir", fixture.configuration.boardDirectory, ...arguments_],
        { cwd: fixture.root },
      );
    await command(["edit", String(fixture.taskId), "--status", "done"]);
    const create = async (arguments_: string[]): Promise<number> => {
      const result = await command(["create", ...arguments_, "--json"]);
      return (JSON.parse(result.stdout) as { id: number }).id;
    };
    const epicId = await create([
      "Example Collection",
      "--status",
      "in-progress",
      "--tags",
      "type:epic",
    ]);
    const sourceId = await create([
      "Prepare Example Collection",
      "--status",
      "done",
      "--parent",
      String(epicId),
      "--tags",
      "lifecycle:sample",
    ]);
    const uatId = await create([
      "Inspect Example Collection",
      "--status",
      "backlog",
      "--parent",
      String(epicId),
      "--tags",
      "uat,lifecycle:sample",
    ]);
    const composition = createProductionComposition({
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
    });
    await composition.start();
    const first = await composition.dynamicTasks.createRecord(
      {
        body: "Apply the accepted example correction.",
        kind: "follow-up",
        lifecycle: "sample",
        operationKey: JSON.stringify([
          `task-${sourceId}`,
          "task-preparation:review:1",
          "follow-up",
          "accepted-correction",
        ]),
        parent: epicId,
        title: "Apply Accepted Correction",
      },
      {
        instanceId: `task-${sourceId}`,
        sessionKey: "task-preparation:review:1",
        taskId: sourceId,
      },
    );

    await composition.scheduler.trigger();
    let board = await composition.board.readBoard();
    expect(board.find(({ id }) => id === first.task.id)?.status).toBe(
      "backlog",
    );
    expect(composition.attention.list()).not.toContainEqual(
      expect.objectContaining({
        attentionId: `epic:${epicId}:acceptance:delivery-child-incomplete`,
      }),
    );

    const uatInstance = composition.persistence.getInstance(`task-${uatId}`)!;
    composition.persistence.updateInstance(`task-${uatId}`, {
      ...uatInstance.state,
      flowcraftContext: {
        ...(uatInstance.state.flowcraftContext as Record<string, unknown>),
        awaitingNodeIds: [],
        status: "completed",
      } as typeof uatInstance.state.flowcraftContext,
    });
    const untrustedId = await create([
      "Unverified Addition",
      "--status",
      "backlog",
      "--parent",
      String(epicId),
      "--tags",
      "type:follow-up,lifecycle:sample",
    ]);
    await composition.scheduler.trigger();

    board = await composition.board.readBoard();
    expect(board.find(({ id }) => id === first.task.id)?.status).toBe("todo");
    expect(board.find(({ id }) => id === untrustedId)?.status).toBe("backlog");
    expect(board.find(({ id }) => id === epicId)?.status).toBe("uat");
    expect(composition.attention.list()).toContainEqual(
      expect.objectContaining({
        attentionId: `epic:${epicId}:acceptance:delivery-child-incomplete`,
        kind: "epic-acceptance",
        message: expect.stringContaining("without exact completed"),
      }),
    );

    const second = await composition.dynamicTasks.createRecord(
      {
        body: "Verify the dependent example correction.",
        dependsOn: [first.task.id],
        kind: "finding",
        lifecycle: "sample",
        operationKey: JSON.stringify([
          `task-${first.task.id}`,
          "task-correction:inspect:1",
          "finding",
          "dependent-check",
        ]),
        parent: epicId,
        title: "Verify Dependent Correction",
      },
      {
        instanceId: `task-${first.task.id}`,
        sessionKey: "task-correction:inspect:1",
        taskId: first.task.id,
      },
    );
    await composition.scheduler.trigger();
    board = await composition.board.readBoard();
    expect(board.find(({ id }) => id === second.task.id)?.status).toBe("todo");
    expect(
      composition.persistence
        .listReconcilerRuntime()
        .some(({ taskId }) => taskId === second.task.id),
    ).toBe(false);

    await command(["edit", String(first.task.id), "--status", "done"]);
    const firstRuntime = composition.persistence
      .listReconcilerRuntime()
      .find(({ taskId }) => taskId === first.task.id)!;
    composition.persistence.writeReconcilerRuntime({
      ...firstRuntime,
      boardStatus: "done",
      state: "done",
    });
    await composition.scheduler.trigger();
    expect(
      composition.persistence
        .listReconcilerRuntime()
        .some(({ taskId }) => taskId === second.task.id),
    ).toBe(true);

    await command(["edit", String(second.task.id), "--status", "done"]);
    const secondRuntime = composition.persistence
      .listReconcilerRuntime()
      .find(({ taskId }) => taskId === second.task.id)!;
    composition.persistence.writeReconcilerRuntime({
      ...secondRuntime,
      boardStatus: "done",
      state: "done",
    });
    await command(["edit", String(untrustedId), "--status", "done"]);
    await composition.scheduler.trigger();

    board = await composition.board.readBoard();
    expect(board.find(({ id }) => id === epicId)?.status).toBe("done");
    expect(
      composition.persistence
        .listReconcilerRuntime()
        .filter(({ taskId }) => taskId === uatId),
    ).toHaveLength(1);
    expect(composition.attention.list()).not.toContainEqual(
      expect.objectContaining({
        attentionId: `epic:${epicId}:acceptance:delivery-child-incomplete`,
      }),
    );
    await composition.close();
  }, 15_000);

  it("orders a Console pause queued after promotion before the start reservation", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    fixture.configuration.pacing.maxConcurrentSessions = 10;
    const command = (arguments_: string[]) =>
      execute(
        "kanban-md",
        ["--dir", fixture.configuration.boardDirectory, ...arguments_],
        { cwd: fixture.root },
      );
    await command(["edit", String(fixture.taskId), "--status", "done"]);
    const create = async (arguments_: string[]): Promise<number> => {
      const result = await command(["create", ...arguments_, "--json"]);
      return (JSON.parse(result.stdout) as { id: number }).id;
    };
    const epicId = await create([
      "Example Schedule",
      "--status",
      "in-progress",
      "--tags",
      "type:epic",
    ]);
    const sourceId = await create([
      "Prepare Example Schedule",
      "--status",
      "done",
      "--parent",
      String(epicId),
      "--tags",
      "lifecycle:sample",
    ]);
    const uatId = await create([
      "Inspect Example Schedule",
      "--status",
      "backlog",
      "--parent",
      String(epicId),
      "--tags",
      "uat,lifecycle:sample",
    ]);
    const composition = createProductionComposition({
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
    });
    await composition.start();
    const uatInstance = composition.persistence.getInstance(`task-${uatId}`)!;
    composition.persistence.updateInstance(`task-${uatId}`, {
      ...uatInstance.state,
      flowcraftContext: {
        ...(uatInstance.state.flowcraftContext as Record<string, unknown>),
        awaitingNodeIds: [],
        status: "completed",
      } as typeof uatInstance.state.flowcraftContext,
    });
    const followUp = await composition.dynamicTasks.createRecord(
      {
        body: "Apply the accepted example adjustment.",
        kind: "follow-up",
        lifecycle: "sample",
        operationKey: JSON.stringify([
          `task-${sourceId}`,
          "task-preparation:review:1",
          "follow-up",
          "accepted-adjustment",
        ]),
        parent: epicId,
        title: "Apply Accepted Adjustment",
      },
      {
        instanceId: `task-${sourceId}`,
        sessionKey: "task-preparation:review:1",
        taskId: sourceId,
      },
    );
    const mirror = composition.board.mirrorTaskStatus.bind(composition.board);
    let pause: Promise<void> | undefined;
    vi.spyOn(composition.board, "mirrorTaskStatus").mockImplementation(
      async (taskId, status) => {
        await mirror(taskId, status);
        if (taskId === followUp.task.id && status === "todo") {
          pause = composition.consoleBoard.setEpicInProgress(epicId, false);
        }
      },
    );

    await composition.scheduler.trigger();
    await pause;

    const board = await composition.board.readBoard();
    expect(board.find(({ id }) => id === followUp.task.id)?.status).toBe(
      "todo",
    );
    expect(board.find(({ id }) => id === epicId)?.status).toBe("todo");
    expect(
      composition.persistence
        .listReconcilerRuntime()
        .some(({ taskId }) => taskId === followUp.task.id),
    ).toBe(false);
    await composition.close();
  }, 15_000);

  it("retains one terminal-unverified attention when the UAT board card has no runtime proof", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const command = (arguments_: string[]) =>
      execute(
        "kanban-md",
        ["--dir", fixture.configuration.boardDirectory, ...arguments_],
        { cwd: fixture.root },
      );
    await command(["edit", String(fixture.taskId), "--status", "done"]);
    const create = async (arguments_: string[]): Promise<number> => {
      const result = await command(["create", ...arguments_, "--json"]);
      return (JSON.parse(result.stdout) as { id: number }).id;
    };
    const epicId = await create([
      "Example Inventory",
      "--status",
      "uat",
      "--tags",
      "type:epic",
    ]);
    const sourceId = await create([
      "Prepare Example Inventory",
      "--status",
      "done",
      "--parent",
      String(epicId),
      "--tags",
      "lifecycle:sample",
    ]);
    await create([
      "Inspect Example Inventory",
      "--status",
      "done",
      "--parent",
      String(epicId),
      "--tags",
      "uat,lifecycle:sample",
    ]);
    const composition = createProductionComposition({
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
    });
    const followUp = await composition.dynamicTasks.createRecord(
      {
        body: "Apply the accepted example inventory correction.",
        kind: "follow-up",
        lifecycle: "sample",
        operationKey: JSON.stringify([
          `task-${sourceId}`,
          "task-inventory:review:1",
          "follow-up",
          "accepted-correction",
        ]),
        parent: epicId,
        title: "Apply Inventory Correction",
      },
      {
        instanceId: `task-${sourceId}`,
        sessionKey: "task-inventory:review:1",
        taskId: sourceId,
      },
    );

    await composition.start();
    await composition.scheduler.trigger();

    expect((await composition.board.readTask(followUp.task.id)).status).toBe(
      "backlog",
    );
    expect(
      composition.attention
        .list()
        .filter(
          ({ attentionId }) =>
            attentionId === `epic:${epicId}:acceptance:uat-terminal-unverified`,
        ),
    ).toEqual([
      expect.objectContaining({
        kind: "epic-acceptance",
        message: expect.stringContaining("without one retained terminal"),
      }),
    ]);
    await composition.close();
  }, 15_000);
});
