// ---
// relationships:
//   verifies: heddle
// ---

import process from "node:process";

import { describe, expect, it, vi } from "vitest";

import { ProductionScheduler } from "./scheduler.js";

describe("production reconciliation scheduler", () => {
  it("reports a failed startup pass and preserves the original failure", async () => {
    const failure = new Error("Injected reconciliation failure");
    const onError = vi.fn(async () => undefined);
    const scheduler = new ProductionScheduler({
      cadenceMilliseconds: 60_000,
      onError,
      pass: async () => {
        throw failure;
      },
      stopTimeoutMilliseconds: 1_000,
    });

    await expect(scheduler.start()).rejects.toBe(failure);

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
    await scheduler.stop().catch(() => undefined);
  });

  it("consumes a rejected cadence error sink and continues later passes", async () => {
    const failure = new Error("Injected cadence failure");
    const sinkFailure = new Error("Injected sink failure");
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    let passes = 0;
    const onError = vi.fn(async () => {
      throw sinkFailure;
    });
    const scheduler = new ProductionScheduler({
      cadenceMilliseconds: 20,
      onError,
      pass: async () => {
        passes += 1;
        if (passes === 2) throw failure;
      },
      stopTimeoutMilliseconds: 1_000,
    });

    try {
      await scheduler.start();
      await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
      await vi.waitFor(() => expect(passes).toBeGreaterThanOrEqual(3));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      await scheduler.stop();
    }
  });

  it("serializes an overlapping tick and drains one later pass", async () => {
    let active = 0;
    let maximumActive = 0;
    let release: (() => void) | undefined;
    let passes = 0;
    const firstBlocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = new ProductionScheduler({
      cadenceMilliseconds: 60_000,
      pass: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        passes += 1;
        if (passes === 1) await firstBlocked;
        active -= 1;
      },
      stopTimeoutMilliseconds: 1_000,
    });

    const starting = scheduler.start();
    await vi.waitFor(() => expect(passes).toBe(1));
    const overlapA = scheduler.trigger();
    const overlapB = scheduler.trigger();
    release?.();
    await Promise.all([starting, overlapA, overlapB]);

    expect(passes).toBe(2);
    expect(maximumActive).toBe(1);
    await scheduler.stop();
  });

  it("drains the owned pass and prevents effects after bounded stop", async () => {
    let passes = 0;
    const scheduler = new ProductionScheduler({
      cadenceMilliseconds: 5,
      pass: async () => {
        passes += 1;
      },
      stopTimeoutMilliseconds: 1_000,
    });
    await scheduler.start();
    await scheduler.stop();
    const stoppedAt = passes;
    await scheduler.trigger();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
    expect(passes).toBe(stoppedAt);
  });

  it("fails within the configured bound when an owned pass cannot drain", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = new ProductionScheduler({
      cadenceMilliseconds: 60_000,
      pass: () => blocked,
      stopTimeoutMilliseconds: 10,
    });

    const starting = scheduler.start();
    await expect(scheduler.stop()).rejects.toThrow(
      "Timed out draining the reconciliation pass",
    );
    await expect(scheduler.stop()).rejects.toThrow(
      "Timed out draining the reconciliation pass",
    );
    release?.();
    await starting;
    await scheduler.stop();
  });
});
