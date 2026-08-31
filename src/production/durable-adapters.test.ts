// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SqlitePersistence } from "../persistence/index.js";
import {
  DurableAttentionQueue,
  DurablePushoverNotifier,
  type PushoverMessage,
} from "./durable-adapters.js";

describe("durable production adapters", () => {
  let directory = "";

  afterEach(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
  });

  it("deduplicates a stable attention ID after a fresh persistence process", async () => {
    directory = await mkdtemp(join(tmpdir(), "heddle-attention-"));
    const firstPersistence = new SqlitePersistence({
      stateDirectory: directory,
    });
    const first = new DurableAttentionQueue(firstPersistence);
    const attention = {
      attentionId: "task-17:session:choice",
      code: "lifecycle-not-declared",
      kind: "lifecycle-resolution" as const,
      message: "Choose a lifecycle",
      taskId: 17,
    };
    await first.raise(attention);
    firstPersistence.close();

    const secondPersistence = new SqlitePersistence({
      stateDirectory: directory,
    });
    const second = new DurableAttentionQueue(secondPersistence);
    expect(await second.has(attention.attentionId)).toBe(true);
    await second.raise(attention);
    expect(second.list()).toHaveLength(1);
    secondPersistence.close();
  });

  it("rejects changed payload under one stable attention ID", async () => {
    directory = await mkdtemp(join(tmpdir(), "heddle-attention-identity-"));
    const persistence = new SqlitePersistence({ stateDirectory: directory });
    const queue = new DurableAttentionQueue(persistence);
    await queue.raise({
      attentionId: "task-19:session:choice",
      code: "lifecycle-not-declared",
      kind: "lifecycle-resolution",
      message: "Choose a lifecycle",
      taskId: 19,
    });

    await expect(
      queue.raise({
        attentionId: "task-19:session:choice",
        code: "lifecycle-not-declared",
        kind: "lifecycle-resolution",
        message: "Choose a different lifecycle",
        taskId: 19,
      }),
    ).rejects.toThrow(
      'Attention "task-19:session:choice" changed durable identity',
    );
    expect(queue.list()).toMatchObject([{ message: "Choose a lifecycle" }]);
    persistence.close();
  });

  it("retains resolved attention identity while hiding it across restart", async () => {
    directory = await mkdtemp(join(tmpdir(), "heddle-attention-resolved-"));
    const attention = {
      attentionId: "task-21:session:choice",
      code: "lifecycle-not-declared",
      kind: "lifecycle-resolution" as const,
      message: "Choose a lifecycle",
      taskId: 21,
    };
    const firstPersistence = new SqlitePersistence({
      stateDirectory: directory,
    });
    const first = new DurableAttentionQueue(firstPersistence);
    await first.raise(attention);
    expect(first.resolve(attention.attentionId)).toBe(true);
    expect(first.list()).toEqual([]);
    expect(await first.has(attention.attentionId)).toBe(true);
    firstPersistence.close();

    const secondPersistence = new SqlitePersistence({
      stateDirectory: directory,
    });
    const second = new DurableAttentionQueue(secondPersistence);
    expect(second.resolve(attention.attentionId)).toBe(false);
    expect(() => second.resolve("task-21:session:unknown")).toThrow(
      'Attention "task-21:session:unknown" does not exist',
    );
    expect(second.list()).toEqual([]);
    expect(await second.has(attention.attentionId)).toBe(true);
    secondPersistence.close();
  });

  it("adds durable resolution state to an existing attention store", async () => {
    directory = await mkdtemp(join(tmpdir(), "heddle-attention-schema-"));
    const database = new Database(join(directory, "heddle-state.sqlite"));
    database.exec(`
      CREATE TABLE heddle_attention (
        attention_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE TABLE heddle_completed_effects (
        effect_kind TEXT NOT NULL,
        stable_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
        recorded_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (effect_kind, stable_id)
      );
    `);
    database.close();

    const persistence = new SqlitePersistence({ stateDirectory: directory });
    const queue = new DurableAttentionQueue(persistence);
    await queue.raise({
      attentionId: "task-23:session:choice",
      code: "lifecycle-not-declared",
      kind: "lifecycle-resolution",
      message: "Choose a lifecycle",
      taskId: 23,
    });
    expect(queue.resolve("task-23:session:choice")).toBe(true);
    expect(queue.list()).toEqual([]);
    expect(
      persistence.recordEffectIntent("sample-effect", "sample-id", {
        action: "first",
      }),
    ).toBe(true);
    expect(() =>
      persistence.recordEffectIntent("sample-effect", "sample-id", {
        action: "second",
      }),
    ).toThrow("changed durable identity");
    persistence.close();
  });

  it("does not repeat a completed dead-session Pushover effect after restart", async () => {
    directory = await mkdtemp(join(tmpdir(), "heddle-pushover-"));
    const sent: PushoverMessage[] = [];
    const transport = {
      send: vi.fn(async (message) => void sent.push(message)),
    };
    const configuration = {
      apiUrl: "https://notify.invalid/messages",
      applicationToken: "application-token",
      consoleBaseUrl: "https://console.invalid/",
      userKey: "operator-key",
    };
    const attention = {
      attentionId: "task-17:session:choice",
      instanceId: "task-17",
      message: "Session sample-one is ended without lifecycle advance",
    };
    const firstPersistence = new SqlitePersistence({
      stateDirectory: directory,
    });
    firstPersistence.writeReconcilerRuntime({
      boardStatus: "in-progress",
      instanceId: "task-17",
      state: "waiting",
      taskId: 17,
    });
    await new DurablePushoverNotifier(
      firstPersistence,
      configuration,
      transport,
    ).send(attention);
    firstPersistence.close();

    const secondPersistence = new SqlitePersistence({
      stateDirectory: directory,
    });
    await new DurablePushoverNotifier(
      secondPersistence,
      configuration,
      transport,
    ).send(attention);
    secondPersistence.close();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.stableId).toBe(attention.attentionId);
    expect(sent[0]?.url).toContain("scope=task%3A17");
  });

  it("records Pushover intent before a failed effect and retries it", async () => {
    directory = await mkdtemp(join(tmpdir(), "heddle-pushover-intent-"));
    const persistence = new SqlitePersistence({ stateDirectory: directory });
    persistence.writeReconcilerRuntime({
      boardStatus: "in-progress",
      instanceId: "task-18",
      state: "waiting",
      taskId: 18,
    });
    let attempts = 0;
    const notifier = new DurablePushoverNotifier(
      persistence,
      {
        apiUrl: "https://notify.invalid/messages",
        applicationToken: "application-token",
        consoleBaseUrl: "https://console.invalid/",
        userKey: "operator-key",
      },
      {
        send: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("Injected transport failure");
        },
      },
    );
    const attention = {
      attentionId: "task-18:session:choice",
      instanceId: "task-18",
      message: "Session sample-two is stalled without lifecycle advance",
    };

    await expect(notifier.send(attention)).rejects.toThrow(
      "Injected transport failure",
    );
    expect(
      persistence.effectIntentRecorded("pushover", attention.attentionId),
    ).toBe(true);
    expect(persistence.effectCompleted("pushover", attention.attentionId)).toBe(
      false,
    );
    await notifier.send(attention);
    expect(persistence.effectCompleted("pushover", attention.attentionId)).toBe(
      true,
    );
    expect(attempts).toBe(2);
    persistence.close();
  });

  it("rejects changed Pushover payload under a pending stable ID", async () => {
    directory = await mkdtemp(join(tmpdir(), "heddle-pushover-payload-"));
    const persistence = new SqlitePersistence({ stateDirectory: directory });
    persistence.writeReconcilerRuntime({
      boardStatus: "in-progress",
      instanceId: "task-20",
      state: "waiting",
      taskId: 20,
    });
    const attention = {
      attentionId: "task-20:session:choice",
      instanceId: "task-20",
      message: "Session sample-three is failed without lifecycle advance",
    };
    const firstTransport = {
      send: vi.fn(async () => {
        throw new Error("Injected ambiguous failure");
      }),
    };
    await expect(
      new DurablePushoverNotifier(
        persistence,
        {
          apiUrl: "https://notify.invalid/messages",
          applicationToken: "application-token",
          consoleBaseUrl: "https://console.invalid/",
          userKey: "operator-key",
        },
        firstTransport,
      ).send(attention),
    ).rejects.toThrow("Injected ambiguous failure");

    const changedTransport = { send: vi.fn(async () => undefined) };
    await expect(
      new DurablePushoverNotifier(
        persistence,
        {
          apiUrl: "https://notify.invalid/messages",
          applicationToken: "changed-application-token",
          consoleBaseUrl: "https://console.invalid/",
          userKey: "operator-key",
        },
        changedTransport,
      ).send(attention),
    ).rejects.toThrow("changed durable identity");
    expect(firstTransport.send).toHaveBeenCalledTimes(1);
    expect(changedTransport.send).not.toHaveBeenCalled();
    expect(persistence.effectCompleted("pushover", attention.attentionId)).toBe(
      false,
    );
    persistence.close();
  });

  it("rejects Pushover without one canonical production task scope", async () => {
    directory = await mkdtemp(join(tmpdir(), "heddle-pushover-scope-"));
    const persistence = new SqlitePersistence({ stateDirectory: directory });
    const transport = { send: vi.fn(async () => undefined) };
    const notifier = new DurablePushoverNotifier(
      persistence,
      {
        apiUrl: "https://notify.invalid/messages",
        applicationToken: "application-token",
        consoleBaseUrl: "https://console.invalid/",
        userKey: "operator-key",
      },
      transport,
    );

    await expect(
      notifier.send({
        attentionId: "instance-19:session:choice",
        instanceId: "instance-19",
        message: "Session sample-four is ended without lifecycle advance",
      }),
    ).rejects.toThrow("does not resolve to one production task");
    expect(transport.send).not.toHaveBeenCalled();
    persistence.close();
  });
});
