// ---
// relationships:
//   verifies: heddle
// ---

import { rename } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createProductionComposition,
  type ProductionComposition,
} from "./composition.js";
import {
  execute,
  prepareProductionFixture,
  SyntheticT3,
} from "./composition.test-support.js";
import { createProductionErrorAttention } from "./error-visibility.js";

describe("production scheduler pass attention", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let composition: ProductionComposition | undefined;

  afterEach(async () => {
    await composition?.close().catch(() => undefined);
    await cleanup?.();
  });

  it("recovers a missing-upstream failure after one complete production pass", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const upstream = (
      await execute("git", ["remote", "get-url", "origin"], {
        cwd: fixture.blueprintsRepositoryRoot,
      })
    ).stdout.trim();
    await execute(
      "git",
      [
        "remote",
        "set-url",
        "origin",
        join(fixture.root, "missing-blueprint-origin.git"),
      ],
      { cwd: fixture.blueprintsRepositoryRoot },
    );
    composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    });

    await expect(composition.start()).rejects.toThrow(
      "The organization blueprint repository could not fetch origin",
    );
    expect(schedulerAttention(composition)).toHaveLength(1);

    await execute("git", ["remote", "set-url", "origin", upstream], {
      cwd: fixture.blueprintsRepositoryRoot,
    });
    await expect(composition.scheduler.trigger()).resolves.toBeUndefined();

    expect(schedulerAttention(composition)).toEqual([]);
    expect(
      composition.persistence
        .listSchedulerPassHistory()
        .map(({ episode, error, type }) => ({ episode, error, type })),
    ).toMatchObject([
      {
        episode: 1,
        error: expect.objectContaining({
          message:
            "The organization blueprint repository could not fetch origin",
        }),
        type: "failure",
      },
      { episode: 1, error: null, type: "recovery" },
    ]);
  });

  it("keeps one live signal through resolution, changing failures, recovery, and recurrence", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const upstream = (
      await execute("git", ["remote", "get-url", "origin"], {
        cwd: fixture.blueprintsRepositoryRoot,
      })
    ).stdout.trim();
    const missingUpstream = join(fixture.root, "missing-blueprint-origin.git");
    const displacedBoard = join(fixture.root, "unavailable-sample-board");
    let boardDisplaced = false;
    const open = (): ProductionComposition => {
      composition = createProductionComposition({
        workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
        blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
        configuration: fixture.configuration,
        providerUsage: {
          readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
        },
        pushoverTransport: { send: vi.fn(async () => undefined) },
        t3: new SyntheticT3(),
      });
      return composition;
    };
    const close = async (): Promise<void> => {
      const current = composition;
      composition = undefined;
      await current?.close().catch(() => undefined);
    };

    try {
      await execute("git", ["remote", "set-url", "origin", missingUpstream], {
        cwd: fixture.blueprintsRepositoryRoot,
      });
      const firstFailure = open();
      firstFailure.persistence.raiseAttention(
        "production:scheduler-pass-failed:legacy",
        createProductionErrorAttention({
          attentionId: "production:scheduler-pass-failed:legacy",
          code: "scheduler-pass-failed",
          error: new Error("Historical sample failure"),
          message: "Historical scheduler pass failed",
        }),
      );
      await expect(firstFailure.start()).rejects.toThrow(
        "The organization blueprint repository could not fetch origin",
      );
      expect(schedulerAttention(firstFailure)).toMatchObject([
        {
          attentionId: "production:scheduler-pass-failed:global:episode:1",
        },
      ]);
      await close();

      const repeatedFailure = open();
      await expect(repeatedFailure.start()).rejects.toThrow(
        "The organization blueprint repository could not fetch origin",
      );
      expect(schedulerAttention(repeatedFailure)).toMatchObject([
        {
          attentionId: "production:scheduler-pass-failed:global:episode:1",
        },
      ]);
      const visible = schedulerAttention(repeatedFailure)[0]!;
      const resolve = visible.actions.find(
        ({ actionId }) => actionId === "attention.resolve",
      )!;
      expect(resolve.contract).toEqual({
        kind: "attention.resolve",
        schedulerFailureSequence: 2,
      });
      await repeatedFailure.consoleActions.execute({
        action: resolve,
        attention: visible,
      });
      await repeatedFailure.consoleActions.execute({
        action: resolve,
        attention: visible,
      });
      expect(schedulerAttention(repeatedFailure)).toEqual([]);
      await close();

      const afterResolution = open();
      await expect(afterResolution.start()).rejects.toThrow(
        "The organization blueprint repository could not fetch origin",
      );
      expect(schedulerAttention(afterResolution)).toHaveLength(1);
      await afterResolution.consoleActions.execute({
        action: resolve,
        attention: visible,
      });
      expect(schedulerAttention(afterResolution)).toHaveLength(1);
      const current = schedulerAttention(afterResolution)[0]!;
      const currentResolve = current.actions.find(
        ({ actionId }) => actionId === "attention.resolve",
      )!;
      expect(currentResolve.contract).toEqual({
        kind: "attention.resolve",
        schedulerFailureSequence: 3,
      });
      await afterResolution.consoleActions.execute({
        action: currentResolve,
        attention: current,
      });
      expect(schedulerAttention(afterResolution)).toEqual([]);
      expect(
        afterResolution.persistence.effectCompleted(
          "console-attention-action",
          `${current.attentionId}:scheduler-failure:2`,
        ),
      ).toBe(true);
      expect(
        afterResolution.persistence.effectCompleted(
          "console-attention-action",
          `${current.attentionId}:scheduler-failure:3`,
        ),
      ).toBe(true);
      await close();

      await rename(fixture.configuration.boardDirectory, displacedBoard);
      boardDisplaced = true;
      await execute("git", ["remote", "set-url", "origin", upstream], {
        cwd: fixture.blueprintsRepositoryRoot,
      });
      const changedFailure = open();
      await expect(changedFailure.start()).rejects.toThrow();
      expect(schedulerAttention(changedFailure)).toHaveLength(1);
      const failures = changedFailure.persistence
        .listSchedulerPassHistory()
        .filter(({ type }) => type === "failure");
      expect(failures).toHaveLength(4);
      expect(
        new Set(failures.map(({ error }) => JSON.stringify(error))).size,
      ).toBe(2);
      expect(failures.every(({ episode }) => episode === 1)).toBe(true);
      await close();

      await rename(displacedBoard, fixture.configuration.boardDirectory);
      boardDisplaced = false;
      const recovered = open();
      await expect(recovered.start()).resolves.toBeUndefined();
      expect(schedulerAttention(recovered)).toEqual([]);
      const recoveredHistory = recovered.persistence.listSchedulerPassHistory();
      expect(recoveredHistory.at(-1)).toMatchObject({
        episode: 1,
        error: null,
        type: "recovery",
      });
      await close();

      await execute("git", ["remote", "set-url", "origin", missingUpstream], {
        cwd: fixture.blueprintsRepositoryRoot,
      });
      const recurrence = open();
      await expect(recurrence.start()).rejects.toThrow(
        "The organization blueprint repository could not fetch origin",
      );
      expect(schedulerAttention(recurrence)).toMatchObject([
        {
          attentionId: "production:scheduler-pass-failed:global:episode:2",
        },
      ]);
      expect(
        recurrence.persistence
          .listSchedulerPassHistory()
          .slice(0, recoveredHistory.length),
      ).toEqual(recoveredHistory);
    } finally {
      await close();
      if (boardDisplaced) {
        await rename(displacedBoard, fixture.configuration.boardDirectory);
      }
    }
  }, 15_000);
});

const schedulerAttention = (composition: ProductionComposition) =>
  composition.attention
    .list()
    .filter(({ attentionId }) =>
      attentionId.startsWith("production:scheduler-pass-failed:"),
    );
