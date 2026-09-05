// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SqlitePersistence } from "../persistence/index.js";
import {
  DurableAttentionQueue,
  DurablePushoverNotifier,
  HttpPushoverTransport,
  NotificationDeliveryError,
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
    expect(second.reopen(attention.attentionId)).toBe(true);
    expect(second.list()).toMatchObject([
      { attentionId: attention.attentionId },
    ]);
    expect(second.reopen(attention.attentionId)).toBe(false);
    expect(() => second.reopen("task-21:session:unknown")).toThrow(
      'Attention "task-21:session:unknown" does not exist',
    );
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

    await expect(notifier.send(attention)).rejects.toMatchObject({
      category: "transport-failure",
      disposition: "retryable",
    });
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

  it.each([
    {
      body: {
        errors: ["sensitive provider detail"],
        status: 0,
        token: "invalid",
      },
      category: "application-credential-rejected",
      status: 400,
    },
    {
      body: {
        errors: ["sensitive provider detail"],
        status: 0,
        user: "invalid",
      },
      category: "recipient-rejected",
      status: 400,
    },
    {
      body: { errors: ["sensitive provider detail"], status: 0 },
      category: "provider-quota-exceeded",
      status: 429,
    },
    {
      body: { errors: ["sensitive provider detail"], status: 0 },
      category: "request-rejected",
      status: 200,
    },
    {
      body: { status: 1 },
      category: "request-rejected",
      status: 202,
    },
    {
      body: "not-json",
      category: "request-rejected",
      status: 400,
    },
  ])(
    "classifies HTTP $status as permanent Pushover $category without exposing its body",
    async ({ body, category, status }) => {
      const transport = new HttpPushoverTransport(
        "https://notify.invalid/messages",
        vi.fn(
          async () =>
            new globalThis.Response(
              typeof body === "string" ? body : JSON.stringify(body),
              {
                headers: { "content-type": "application/json" },
                status,
              },
            ),
        ),
      );

      const failure = await transport
        .send({
          applicationToken: "application-token",
          message: "A sample needs attention",
          stableId: "sample-attention",
          title: "Sample attention",
          url: "https://console.invalid/",
          userKey: "operator-key",
        })
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ category, disposition: "permanent" });
      expect(String(failure)).not.toContain("sensitive provider detail");
    },
  );

  it.each([
    { body: { status: 0 }, category: "provider-unavailable", status: 503 },
    { body: "not-json", category: "invalid-response", status: 200 },
  ])(
    "classifies HTTP $status as retryable Pushover $category",
    async ({ body, category, status }) => {
      const transport = new HttpPushoverTransport(
        "https://notify.invalid/messages",
        vi.fn(
          async () =>
            new globalThis.Response(
              typeof body === "string" ? body : JSON.stringify(body),
              { status },
            ),
        ),
      );

      const failure = await transport
        .send({
          applicationToken: "application-token",
          message: "A sample needs attention",
          stableId: "sample-attention",
          title: "Sample attention",
          url: "https://console.invalid/",
          userKey: "operator-key",
        })
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ category, disposition: "retryable" });
    },
  );

  it("holds a permanent rejection until its exact occurrence is authorized", async () => {
    directory = await mkdtemp(join(tmpdir(), "heddle-pushover-rejected-"));
    const persistence = new SqlitePersistence({ stateDirectory: directory });
    persistence.writeReconcilerRuntime({
      boardStatus: "in-progress",
      instanceId: "task-24",
      state: "waiting",
      taskId: 24,
    });
    const rejected = vi.fn(async () => {
      throw new NotificationDeliveryError(
        "permanent",
        "application-credential-rejected",
      );
    });
    const attention = {
      attentionId: "task-24:session:choice",
      instanceId: "task-24",
      message: "Session sample-five needs an operator choice",
    };
    const configuration = {
      apiUrl: "https://notify.invalid/messages",
      applicationToken: "retired-application-token",
      consoleBaseUrl: "https://console.invalid/",
      userKey: "operator-key",
    };
    const notifier = new DurablePushoverNotifier(persistence, configuration, {
      send: rejected,
    });

    await expect(notifier.send(attention)).rejects.toMatchObject({
      category: "application-credential-rejected",
      occurrence: 1,
    });
    await expect(notifier.send(attention)).rejects.toMatchObject({
      occurrence: 1,
    });
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(
      persistence.authorizeNotificationRetry(attention.attentionId, 2),
    ).toBe(false);
    expect(
      persistence.authorizeNotificationRetry(attention.attentionId, 1),
    ).toBe(true);

    const rejectedAgain = vi.fn(async () => {
      throw new NotificationDeliveryError("permanent", "request-rejected");
    });
    await expect(
      new DurablePushoverNotifier(
        persistence,
        { ...configuration, applicationToken: "replacement-application-token" },
        { send: rejectedAgain },
      ).send(attention),
    ).rejects.toMatchObject({ occurrence: 2 });
    expect(
      persistence.authorizeNotificationRetry(attention.attentionId, 1),
    ).toBe(false);
    expect(
      persistence.authorizeNotificationRetry(attention.attentionId, 2),
    ).toBe(true);

    const accepted = vi.fn(async () => undefined);
    await new DurablePushoverNotifier(
      persistence,
      { ...configuration, applicationToken: "replacement-application-token" },
      { send: accepted },
    ).send(attention);
    expect(accepted).toHaveBeenCalledOnce();
    expect(persistence.effectCompleted("pushover", attention.attentionId)).toBe(
      true,
    );

    const database = new Database(join(directory, "heddle-state.sqlite"), {
      readonly: true,
    });
    const stored = JSON.stringify(
      database.prepare("SELECT * FROM heddle_completed_effects").all(),
    );
    database.close();
    expect(stored).not.toContain("retired-application-token");
    expect(stored).not.toContain("replacement-application-token");
    expect(stored).not.toContain("operator-key");
    persistence.close();
  });

  it("does not authorize a recipient change with an application credential retry", async () => {
    directory = await mkdtemp(join(tmpdir(), "heddle-pushover-recipient-"));
    const persistence = new SqlitePersistence({ stateDirectory: directory });
    persistence.writeReconcilerRuntime({
      boardStatus: "in-progress",
      instanceId: "task-25",
      state: "waiting",
      taskId: 25,
    });
    const attention = {
      attentionId: "task-25:session:choice",
      instanceId: "task-25",
      message: "Session sample-six needs an operator choice",
    };
    const configuration = {
      apiUrl: "https://notify.invalid/messages",
      applicationToken: "retired-application-token",
      consoleBaseUrl: "https://console.invalid/",
      userKey: "first-operator-key",
    };
    await expect(
      new DurablePushoverNotifier(persistence, configuration, {
        send: async () => {
          throw new NotificationDeliveryError("permanent", "request-rejected");
        },
      }).send(attention),
    ).rejects.toBeInstanceOf(NotificationDeliveryError);
    expect(
      persistence.authorizeNotificationRetry(attention.attentionId, 1),
    ).toBe(true);

    const changed = vi.fn(async () => undefined);
    await expect(
      new DurablePushoverNotifier(
        persistence,
        { ...configuration, userKey: "second-operator-key" },
        { send: changed },
      ).send(attention),
    ).rejects.toThrow("changed durable identity");
    expect(changed).not.toHaveBeenCalled();
    persistence.close();
  });

  it("upgrades a matching legacy pending fingerprint without sending twice", async () => {
    directory = await mkdtemp(join(tmpdir(), "heddle-pushover-legacy-"));
    const persistence = new SqlitePersistence({ stateDirectory: directory });
    persistence.writeReconcilerRuntime({
      boardStatus: "in-progress",
      instanceId: "task-26",
      state: "waiting",
      taskId: 26,
    });
    const attention = {
      attentionId: "task-26:session:choice",
      instanceId: "task-26",
      message: "Session sample-seven needs an operator choice",
    };
    const configuration = {
      apiUrl: "https://notify.invalid/messages",
      applicationToken: "application-token",
      consoleBaseUrl: "https://console.invalid/",
      userKey: "operator-key",
    };
    const message = {
      applicationToken: configuration.applicationToken,
      message: attention.message,
      stableId: attention.attentionId,
      title: "Heddle needs attention",
      url: "https://console.invalid/?view=lifecycle&scope=task%3A26&attention=task-26%3Asession%3Achoice",
      userKey: configuration.userKey,
    };
    persistence.recordEffectIntent("pushover", attention.attentionId, {
      messageFingerprint: createHash("sha256")
        .update(JSON.stringify(message))
        .digest("hex"),
    });
    const transport = { send: vi.fn(async () => undefined) };

    await new DurablePushoverNotifier(
      persistence,
      configuration,
      transport,
    ).send(attention);

    expect(transport.send).toHaveBeenCalledOnce();
    expect(persistence.effectCompleted("pushover", attention.attentionId)).toBe(
      true,
    );
    persistence.close();
  });

  it("requires exact operator authorization before recovering a changed legacy route", async () => {
    directory = await mkdtemp(
      join(tmpdir(), "heddle-pushover-legacy-recovery-"),
    );
    const persistence = new SqlitePersistence({ stateDirectory: directory });
    persistence.writeReconcilerRuntime({
      boardStatus: "in-progress",
      instanceId: "task-27",
      state: "waiting",
      taskId: 27,
    });
    const attention = {
      attentionId: "task-27:session:choice",
      instanceId: "task-27",
      message: "Session sample-eight needs an operator choice",
    };
    const retired = {
      apiUrl: "https://notify.invalid/messages",
      applicationToken: "retired-application-token",
      consoleBaseUrl: "https://console.invalid/",
      userKey: "operator-key",
    };
    const retiredMessage = {
      applicationToken: retired.applicationToken,
      message: attention.message,
      stableId: attention.attentionId,
      title: "Heddle needs attention",
      url: "https://console.invalid/?view=lifecycle&scope=task%3A27&attention=task-27%3Asession%3Achoice",
      userKey: retired.userKey,
    };
    persistence.recordEffectIntent("pushover", attention.attentionId, {
      messageFingerprint: createHash("sha256")
        .update(JSON.stringify(retiredMessage))
        .digest("hex"),
    });
    const transport = { send: vi.fn(async () => undefined) };
    const recovered = new DurablePushoverNotifier(
      persistence,
      { ...retired, applicationToken: "replacement-application-token" },
      transport,
    );

    await expect(recovered.send(attention)).rejects.toMatchObject({
      category: "legacy-intent-unverifiable",
      disposition: "operator-action",
      occurrence: 1,
    });
    await expect(recovered.send(attention)).rejects.toMatchObject({
      occurrence: 1,
    });
    expect(transport.send).not.toHaveBeenCalled();
    expect(
      persistence.authorizeNotificationRetry(attention.attentionId, 1),
    ).toBe(true);

    await recovered.send(attention);
    expect(transport.send).toHaveBeenCalledOnce();
    expect(persistence.effectCompleted("pushover", attention.attentionId)).toBe(
      true,
    );
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
    ).rejects.toMatchObject({
      category: "transport-failure",
      disposition: "retryable",
    });

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
