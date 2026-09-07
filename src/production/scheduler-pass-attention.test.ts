// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SqlitePersistence } from "../persistence/index.js";
import { DurableAttentionQueue } from "./durable-adapters.js";
import { SchedulerPassAttentionLifecycle } from "./scheduler-pass-attention.js";

describe("scheduler pass attention lifecycle", () => {
  let directory = "";

  afterEach(async () => {
    if (directory !== "") {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("bounds live attention while retaining failure, recovery, and recurrence history", async () => {
    directory = await mkdtemp(join(tmpdir(), "scheduler-pass-attention-"));
    const persistence = new SqlitePersistence({ stateDirectory: directory });
    const pages = { replayPending: vi.fn(), send: vi.fn() };
    const attention = new DurableAttentionQueue(persistence, pages);
    const lifecycle = new SchedulerPassAttentionLifecycle(
      persistence,
      attention,
    );
    const failureA = new Error("First sample failure");
    const failureB = new TypeError("Second sample failure");

    await lifecycle.failure(failureA);
    await lifecycle.failure(failureA);
    const episodeOneId = "production:scheduler-pass-failed:global:episode:1";
    expect(attention.list()).toMatchObject([
      {
        attentionId: episodeOneId,
        message: expect.stringContaining("First sample failure"),
      },
    ]);
    expect(persistence.listAttention()[0]?.payload).toMatchObject({
      incidentId: null,
    });
    attention.resolve(episodeOneId);
    await lifecycle.failure(failureA);
    await lifecycle.failure(failureB);

    expect(attention.list()).toMatchObject([
      {
        attentionId: episodeOneId,
        message: expect.stringContaining("First sample failure"),
      },
    ]);
    expect(pages.send).toHaveBeenCalledTimes(1);
    expect(
      persistence
        .listSchedulerPassHistory()
        .map(({ episode, error, type }) => ({ episode, error, type })),
    ).toEqual([
      {
        episode: 1,
        error: { cause: null, message: "First sample failure", name: "Error" },
        type: "failure",
      },
      {
        episode: 1,
        error: { cause: null, message: "First sample failure", name: "Error" },
        type: "failure",
      },
      {
        episode: 1,
        error: { cause: null, message: "First sample failure", name: "Error" },
        type: "failure",
      },
      {
        episode: 1,
        error: {
          cause: null,
          message: "Second sample failure",
          name: "TypeError",
        },
        type: "failure",
      },
    ]);

    lifecycle.recovery();
    expect(attention.list()).toEqual([]);
    expect(await attention.has(episodeOneId)).toBe(true);
    const recoveredHistory = persistence.listSchedulerPassHistory();
    expect(recoveredHistory.at(-1)).toMatchObject({
      episode: 1,
      error: null,
      type: "recovery",
    });

    await lifecycle.failure(failureA);
    expect(attention.list()).toMatchObject([
      {
        attentionId: "production:scheduler-pass-failed:global:episode:2",
        message: expect.stringContaining("First sample failure"),
      },
    ]);
    expect(persistence.listSchedulerPassHistory().slice(0, -1)).toEqual(
      recoveredHistory,
    );
    persistence.close();
  });
});
