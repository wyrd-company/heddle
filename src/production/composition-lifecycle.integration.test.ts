// ---
// relationships:
//   verifies: heddle
// ---

import { afterEach, describe, expect, it, vi } from "vitest";

import { bootstrapStageSession } from "../control-plane/index.js";
import { advanceOperationId } from "../mcp-server/operations.js";
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
      operationId: advanceOperationId(`task-${taskId}:implement:1`),
      output: { result: { count: 2 } },
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
    const reviewTurn = t3.commands.filter(
      ({ type }) => type === "thread.turn.start",
    )[1];
    const reviewHandoff = JSON.parse(
      (reviewTurn?.["message"] as { text: string }).text,
    ) as { stage: unknown };
    expect(reviewHandoff.stage).toEqual({
      kind: "standard",
      name: "review",
      priorStageOutputs: [{ result: { count: 2 } }],
    });
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
      operationId: advanceOperationId(`task-${taskId}:implement:1`),
    });
    await composition.scheduler.trigger();
    await composition.lifecycle.resume({
      disposition: "reject",
      instanceId: `task-${taskId}`,
      operationId: advanceOperationId(`task-${taskId}:review:1`),
      output: {
        findings: [{ code: "P1", summary: "The recorded count is unchecked" }],
        transcript: ["private discussion"],
      },
    });
    await composition.scheduler.trigger();
    const remediationTurn = t3.commands.filter(
      ({ type }) => type === "thread.turn.start",
    )[2];
    const remediationText = (remediationTurn?.["message"] as { text: string })
      .text;
    expect(JSON.parse(remediationText)).toMatchObject({
      stage: {
        kind: "remediation",
        name: "remediate",
        reviewFindings: [
          { code: "P1", summary: "The recorded count is unchecked" },
        ],
      },
    });
    expect(remediationText).not.toContain("private discussion");
    expect(remediationText).not.toContain("transcript");
    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId: `task-${taskId}`,
      operationId: advanceOperationId(`task-${taskId}:remediate:1`),
      output: { correction: { count: 3 } },
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
    const repeatedReviewTurn = t3.commands.filter(
      ({ type }) => type === "thread.turn.start",
    )[3];
    const repeatedReviewHandoff = JSON.parse(
      (repeatedReviewTurn?.["message"] as { text: string }).text,
    ) as { stage: { priorStageOutputs: unknown[] } };
    expect(repeatedReviewHandoff.stage.priorStageOutputs).toEqual([
      {},
      {
        findings: [{ code: "P1", summary: "The recorded count is unchecked" }],
        transcript: ["private discussion"],
      },
      { correction: { count: 3 } },
    ]);
    await composition.close();
  });

  it("fails closed when remediation has no canonical review findings", async () => {
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
    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId: `task-${taskId}`,
      operationId: advanceOperationId(`task-${taskId}:implement:1`),
    });
    await composition.scheduler.trigger();
    await composition.lifecycle.resume({
      disposition: "reject",
      instanceId: `task-${taskId}`,
      operationId: advanceOperationId(`task-${taskId}:review:1`),
    });

    await expect(composition.scheduler.trigger()).rejects.toThrow(
      'Remediation stage "remediate" has no canonical review findings',
    );
    await composition.close();
  });

  it("rejects handoff input that disagrees with pinned stage metadata", async () => {
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
    const commandsBeforeMismatch = t3.commands.length;

    await expect(
      bootstrapStageSession(
        {
          handoff: {
            skillPointer: configuration.session.skillPointer,
            stage: {
              kind: "remediation",
              name: "implement",
              review: { findings: [] },
            },
            taskContract: { title: "Example Item" },
          },
          instanceId: `task-${taskId}`,
          interactionMode: configuration.session.interactionMode,
          modelSelection: {
            instanceId: configuration.session.driver,
            model: configuration.session.model,
          },
          projectId: configuration.projectId,
          providerContext: {
            cliVersion: configuration.session.cliVersion,
            driver: configuration.session.driver,
            lifecycle: "independent",
          },
          runtimeMode: configuration.session.runtimeMode,
          sessionKey: `task-${taskId}:mismatch:1`,
          title: "Metadata agreement probe",
          worktree: {
            baseRef: configuration.session.baseRef,
            branch: `heddle/task-${taskId}`,
            repositoryName: configuration.session.repositoryName,
            repositoryRoot: configuration.repositoryRoot,
            worktreeName: `task-${taskId}`,
            worktreesRoot: configuration.session.worktreesRoot,
          },
        },
        { persistence: composition.persistence, t3 },
      ),
    ).rejects.toThrow(
      "Stage session bootstrap requires matching wait-stage handoff metadata and tools",
    );
    expect(t3.commands).toHaveLength(commandsBeforeMismatch);
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
      operationId: advanceOperationId(`task-${taskId}:implement:1`),
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
      operationId: advanceOperationId(`task-${taskId}:implement:1`),
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
