// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwd } from "node:process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SqlitePersistence } from "../persistence/index.js";
import {
  DurableAttentionQueue,
  DurablePushoverNotifier,
  type PushoverMessage,
} from "./durable-adapters.js";
import { productionErrorAttention } from "./error-visibility.js";
import {
  ProductionErrorPager,
  productionErrorPagePolicy,
} from "./production-error-paging.js";

const configuration = {
  apiUrl: "https://notify.invalid/messages",
  applicationToken: "application-token",
  consoleBaseUrl: "https://console.invalid/",
  userKey: "operator-key",
};

describe("production error paging", () => {
  let directory = "";

  afterEach(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
  });

  const prepare = async (now: () => number = () => 0) => {
    directory = await mkdtemp(join(tmpdir(), "heddle-error-pages-"));
    const persistence = new SqlitePersistence({ stateDirectory: directory });
    const deliveries: PushoverMessage[] = [];
    const notifier = new DurablePushoverNotifier(persistence, configuration, {
      send: async (message) => void deliveries.push(message),
    });
    return {
      deliveries,
      pager: new ProductionErrorPager(persistence, notifier, now),
      persistence,
    };
  };

  it("pages eligible and floor errors at their exact level with stable attention identity", async () => {
    const { deliveries, pager, persistence } = await prepare();
    const eligible = productionErrorAttention({
      code: "task-reconciliation-failed",
      error: new Error("Synthetic task failure"),
      summary: "Task reconciliation failed",
      taskId: 17,
    });
    const floor = productionErrorAttention({
      code: "scheduler-pass-failed",
      error: new Error("Synthetic scheduler failure"),
      summary: "Scheduler pass failed",
      varyByError: true,
    });

    await pager.send(eligible);
    await pager.send(eligible);
    await pager.send(floor);

    expect(deliveries).toMatchObject([
      {
        level: "informational",
        stableId: eligible.attentionId,
        url: expect.stringContaining("scope=task%3A17"),
      },
      {
        level: "critical",
        stableId: floor.attentionId,
        url: expect.stringContaining("scope=all"),
      },
    ]);
    persistence.close();
  });

  it("bounds varying identities from one flapping code by cooldown and window cap", async () => {
    let now = 0;
    const { deliveries, pager, persistence } = await prepare(() => now);
    const attentions = [0, 1, 2, 3, 4].map((index) =>
      productionErrorAttention({
        code: "scheduler-pass-failed",
        error: new Error(`Synthetic scheduler failure ${index}`),
        summary: "Scheduler pass failed",
        varyByError: true,
      }),
    );
    for (const [index, time] of [0, 1, 60_000, 120_000, 180_000].entries()) {
      now = time;
      await pager.send(attentions[index]!);
    }

    expect(productionErrorPagePolicy).toEqual({
      cooldownMilliseconds: 60_000,
      maximumPagesPerWindow: 3,
      windowMilliseconds: 300_000,
    });
    expect(deliveries).toHaveLength(3);
    expect(deliveries.map(({ stableId }) => stableId)).toEqual([
      attentions[0]!.attentionId,
      attentions[2]!.attentionId,
      attentions[3]!.attentionId,
    ]);
    expect(new Set(deliveries.map(({ stableId }) => stableId))).toHaveLength(3);
    persistence.close();
  });

  it("keeps the per-code window bound across a service restart", async () => {
    directory = await mkdtemp(join(tmpdir(), "heddle-error-pages-"));
    let now = 0;
    const deliveries: PushoverMessage[] = [];
    const pageWith = async (
      persistence: SqlitePersistence,
      index: number,
    ): Promise<void> => {
      const notifier = new DurablePushoverNotifier(persistence, configuration, {
        send: async (message) => void deliveries.push(message),
      });
      await new ProductionErrorPager(persistence, notifier, () => now).send(
        productionErrorAttention({
          code: "scheduler-pass-failed",
          error: new Error(`Synthetic restarted failure ${index}`),
          summary: "Scheduler pass failed",
          varyByError: true,
        }),
      );
    };
    let persistence = new SqlitePersistence({ stateDirectory: directory });
    await pageWith(persistence, 0);
    persistence.close();

    persistence = new SqlitePersistence({ stateDirectory: directory });
    for (const [index, time] of [60_000, 120_000, 180_000].entries()) {
      now = time;
      await pageWith(persistence, index + 1);
    }

    expect(deliveries).toHaveLength(3);
    persistence.close();
  });

  it("rejects invalid rate policy and admits one stable identity once", async () => {
    const { persistence } = await prepare();
    const admission = {
      attentionId: "production:scheduler-pass-failed:global:sample",
      attemptedAt: 0,
      code: "scheduler-pass-failed",
      ...productionErrorPagePolicy,
    };

    expect(persistence.admitProductionErrorPage(admission)).toBe(true);
    expect(
      persistence.admitProductionErrorPage({
        ...admission,
        attemptedAt: productionErrorPagePolicy.cooldownMilliseconds,
      }),
    ).toBe(false);
    expect(() =>
      persistence.admitProductionErrorPage({ ...admission, attemptedAt: -1 }),
    ).toThrow("attemptedAt must be a non-negative safe integer");
    expect(() =>
      persistence.admitProductionErrorPage({
        ...admission,
        cooldownMilliseconds: 0,
      }),
    ).toThrow("Production error page policy must be positive");
    persistence.close();
  });

  it("replays an admitted eligible page after a crash before page intent", async () => {
    const { deliveries, pager, persistence } = await prepare();
    const attention = productionErrorAttention({
      code: "task-reconciliation-failed",
      error: new Error("Synthetic task failure"),
      summary: "Task reconciliation failed",
      taskId: 31,
    });
    persistence.raiseAttention(
      attention.attentionId,
      JSON.parse(JSON.stringify(attention)),
    );
    expect(
      persistence.admitProductionErrorPage({
        attentionId: attention.attentionId,
        attemptedAt: 0,
        code: attention.code,
        ...productionErrorPagePolicy,
      }),
    ).toBe(true);

    await pager.replayPending();

    expect(deliveries).toMatchObject([
      { level: "informational", stableId: attention.attentionId },
    ]);
    expect(
      persistence.effectCompleted(
        "production-error-pushover",
        attention.attentionId,
      ),
    ).toBe(true);
    persistence.close();
  });

  it("completes a pending floor page without repeating its delivered transport", async () => {
    const { deliveries, pager, persistence } = await prepare();
    const attention = productionErrorAttention({
      code: "scheduler-pass-failed",
      error: new Error("Synthetic scheduler failure"),
      summary: "Scheduler pass failed",
      varyByError: true,
    });
    persistence.raiseAttention(
      attention.attentionId,
      JSON.parse(JSON.stringify(attention)),
    );
    persistence.recordEffectIntent(
      "production-error-pushover",
      attention.attentionId,
      {
        attentionId: attention.attentionId,
        level: "critical",
        message: attention.message,
        scope: "all",
      },
    );

    await pager.replayPending();

    expect(deliveries).toHaveLength(0);
    expect(
      persistence.effectCompleted(
        "production-error-pushover",
        attention.attentionId,
      ),
    ).toBe(true);
    persistence.close();
  });

  it("attempts a floor page before a failed durable record", async () => {
    const { deliveries, pager, persistence } = await prepare();
    const queue = new DurableAttentionQueue(persistence, pager);
    persistence.close();

    await expect(
      queue.raise(
        productionErrorAttention({
          code: "scheduler-pass-failed",
          error: new Error("Synthetic scheduler failure"),
          summary: "Scheduler pass failed",
          varyByError: true,
        }),
      ),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(deliveries).toHaveLength(1);
  });

  it("bounds floor pages in memory while durable admission is unavailable", async () => {
    let now = 0;
    const { deliveries, pager, persistence } = await prepare(() => now);
    const queue = new DurableAttentionQueue(persistence, pager);
    persistence.close();
    const attentions = [0, 1, 2, 3, 4].map((index) =>
      productionErrorAttention({
        code: "scheduler-pass-failed",
        error: new Error(`Synthetic unavailable persistence ${index}`),
        summary: "Scheduler pass failed",
        varyByError: true,
      }),
    );

    for (const [index, time] of [0, 1, 60_000, 120_000, 180_000].entries()) {
      now = time;
      await expect(queue.raise(attentions[index]!)).rejects.toBeDefined();
    }

    expect(deliveries.map(({ stableId }) => stableId)).toEqual([
      attentions[0]!.attentionId,
      attentions[2]!.attentionId,
      attentions[3]!.attentionId,
    ]);
  });

  it("preserves the degraded cooldown across the five-minute window boundary", async () => {
    let now = 0;
    const { deliveries, pager, persistence } = await prepare(() => now);
    const queue = new DurableAttentionQueue(persistence, pager);
    persistence.close();
    const attentions = [0, 1, 2, 3].map((index) =>
      productionErrorAttention({
        code: "scheduler-pass-failed",
        error: new Error(`Synthetic rollover failure ${index}`),
        summary: "Scheduler pass failed",
        varyByError: true,
      }),
    );

    for (const [index, time] of [0, 60_000, 299_999, 300_000].entries()) {
      now = time;
      await expect(queue.raise(attentions[index]!)).rejects.toBeDefined();
    }

    expect(deliveries.map(({ stableId }) => stableId)).toEqual([
      attentions[0]!.attentionId,
      attentions[1]!.attentionId,
      attentions[2]!.attentionId,
    ]);
  });

  it("documents the degraded floor rate limit in both production contracts", async () => {
    const documents = await Promise.all(
      [
        "docs/operators/production-composition.md",
        "docs/technical-designs/heddle.yml",
      ].map((path) => readFile(join(cwd(), path), "utf8")),
    );

    for (const document of documents) {
      const prose = document.replace(/\s+/g, " ");
      expect(prose).toContain("While SQLite is available");
      expect(prose).toContain("in-memory window");
      expect(prose).toMatch(/(?:reset.{0,40}restart|restart.{0,40}reset)/i);
      expect(prose).not.toMatch(/Production-error pages have a durable/);
    }
  });

  it("retains a floor attention when its page transport fails", async () => {
    directory = await mkdtemp(join(tmpdir(), "heddle-error-pages-"));
    const persistence = new SqlitePersistence({ stateDirectory: directory });
    const transportFailure = new Error("Synthetic page failure");
    const notifier = new DurablePushoverNotifier(persistence, configuration, {
      send: vi.fn(async () => Promise.reject(transportFailure)),
    });
    const queue = new DurableAttentionQueue(
      persistence,
      new ProductionErrorPager(persistence, notifier),
    );
    const attention = productionErrorAttention({
      code: "scheduler-pass-failed",
      error: new Error("Synthetic scheduler failure"),
      summary: "Scheduler pass failed",
      varyByError: true,
    });

    await expect(queue.raise(attention)).resolves.toBeUndefined();
    expect(queue.list()).toMatchObject([
      { attentionId: attention.attentionId },
    ]);
    persistence.close();
  });
});
