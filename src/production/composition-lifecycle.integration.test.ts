// ---
// relationships:
//   verifies: heddle
// ---

import { afterEach, describe, expect, it, vi } from "vitest";

import { createProductionComposition } from "./composition.js";
import {
  prepareProductionFixture,
  SyntheticT3,
} from "./composition.test-support.js";

describe("production lifecycle composition", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
  });

  const prepare = async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    return fixture;
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

  it("activates the next accepted lifecycle wait stage without losing prior observation", async () => {
    const { configuration, taskId } = await prepare();
    const t3 = new SyntheticT3();
    const composition = createProductionComposition({
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });
    await composition.start();
    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId: `task-${taskId}`,
      operationId: "advance-implement",
    });
    await composition.scheduler.trigger();

    expect(composition.persistence.listReconcilerRuntime()).toMatchObject([
      { stageId: "review", state: "waiting", taskId },
    ]);
    expect(composition.persistence.listSessionRuntime()).toMatchObject([
      { stageId: "implement" },
      { stageId: "review" },
    ]);
    const creates = t3.commands.filter(({ type }) => type === "thread.create");
    expect(creates).toHaveLength(2);
    expect(creates[0]?.title).not.toBe(creates[1]?.title);
    expect(creates[0]?.branch).toBe(`heddle/task-${taskId}`);
    expect(creates[1]?.branch).toBe(creates[0]?.branch);
    expect(creates[1]?.worktreePath).toBe(creates[0]?.worktreePath);
    expect(
      await composition.consoleState.listEvents({ afterSequence: 0 }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "observation:thread-recorded" }),
      ]),
    );
    await composition.close();
  });

  it("uses a new deterministic activation identity when a stage recurs", async () => {
    const { configuration, taskId } = await prepare();
    const t3 = new SyntheticT3();
    const composition = createProductionComposition({
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });
    await composition.start();
    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId: `task-${taskId}`,
      operationId: "advance-implement",
    });
    await composition.scheduler.trigger();
    await composition.lifecycle.resume({
      disposition: "reject",
      instanceId: `task-${taskId}`,
      operationId: "advance-review-one",
    });
    await composition.scheduler.trigger();
    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId: `task-${taskId}`,
      operationId: "advance-remediate",
    });
    await composition.scheduler.trigger();

    const reviewSessions = composition.persistence
      .listSessionRuntime()
      .filter(({ stageId }) => stageId === "review");
    expect(reviewSessions).toHaveLength(2);
    expect(reviewSessions[0]?.sessionKey).not.toBe(
      reviewSessions[1]?.sessionKey,
    );
    expect(reviewSessions[0]?.threadId).not.toBe(reviewSessions[1]?.threadId);
    const reviewTitles = t3.commands
      .filter(
        ({ threadId, type }) =>
          type === "thread.create" &&
          reviewSessions.some((session) => session.threadId === threadId),
      )
      .map(({ title }) => title);
    expect(new Set(reviewTitles).size).toBe(2);
    await composition.close();
  });

  it("keeps the intended occurrence after a crash before session intent persistence", async () => {
    const { configuration, taskId } = await prepare();
    const first = createProductionComposition({
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    });
    await first.start();
    await first.lifecycle.resume({
      disposition: "complete",
      instanceId: `task-${taskId}`,
      operationId: "advance-implement",
    });
    const runtime = first.persistence.listReconcilerRuntime()[0]!;
    first.persistence.writeReconcilerRuntime({
      ...runtime,
      sessionKey: `task-${taskId}:review:1`,
      stageId: "review",
      state: "starting",
      threadId: "review-thread-1",
    });
    await first.close();

    const t3 = new SyntheticT3();
    const restarted = createProductionComposition({
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });
    await restarted.start();

    expect(restarted.persistence.listSessionRuntime()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionKey: `task-${taskId}:review:1`,
          threadId: "review-thread-1",
        }),
      ]),
    );
    expect(
      t3.commands.find(({ type }) => type === "thread.create")?.title,
    ).toContain("review-1");
    await restarted.close();
  });

  it("keeps a double-digit occurrence identity after session intent persistence", async () => {
    const { configuration, taskId } = await prepare();
    const first = createProductionComposition({
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    });
    await first.start();
    await first.lifecycle.resume({
      disposition: "complete",
      instanceId: `task-${taskId}`,
      operationId: "advance-implement",
    });
    for (let activation = 1; activation <= 10; activation += 1) {
      first.persistence.writeSessionRuntime({
        activation,
        instanceId: `task-${taskId}`,
        sessionKey: `task-${taskId}:review:${activation}`,
        stageId: "review",
        threadId: `review-thread-${activation}`,
      });
    }
    const runtime = first.persistence.listReconcilerRuntime()[0]!;
    first.persistence.writeReconcilerRuntime({
      ...runtime,
      sessionKey: `task-${taskId}:review:10`,
      stageId: "review",
      state: "starting",
      threadId: "review-thread-10",
    });
    await first.close();

    const t3 = new SyntheticT3();
    const restarted = createProductionComposition({
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });
    await restarted.start();

    expect(
      t3.commands.find(({ type }) => type === "thread.create")?.title,
    ).toContain("review-10");
    await restarted.close();
  });
});
