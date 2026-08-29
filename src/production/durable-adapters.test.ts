// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("does not repeat a completed Pushover effect after restart", async () => {
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
      escalationId: "choice",
      instanceId: "task-17",
      openedAt: "2030-01-01T00:00:00.000Z",
      ownerSessionKey: "task-17:implement",
      questions: [],
      stage: "implement",
    };
    const firstPersistence = new SqlitePersistence({
      stateDirectory: directory,
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
  });

  it("records Pushover intent before a failed effect and retries it", async () => {
    directory = await mkdtemp(join(tmpdir(), "heddle-pushover-intent-"));
    const persistence = new SqlitePersistence({ stateDirectory: directory });
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
      escalationId: "choice",
      instanceId: "task-18",
      openedAt: "2030-01-01T00:00:00.000Z",
      ownerSessionKey: "task-18:implement",
      questions: [],
      stage: "implement",
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
});
