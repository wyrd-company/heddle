// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  boardRecordIdentity,
  type BoardTask,
  type CreateBoardRecord,
} from "../board-adapter/index.js";
import { SqlitePersistence } from "../persistence/index.js";
import { DynamicTaskAuthority } from "./dynamic-task-authority.js";
import type { ProductionErrorAttention } from "./error-visibility.js";

const temporaryDirectories: string[] = [];

const makePersistence = async (): Promise<SqlitePersistence> => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "dynamic-task-authority-"),
  );
  temporaryDirectories.push(stateDirectory);
  return new SqlitePersistence({ stateDirectory });
};

const task = (id: number, options: Partial<BoardTask> = {}): BoardTask => ({
  blocked: false,
  body: "",
  dependencies: [],
  frontMatter: { id, title: `Sample ${id}` },
  id,
  priority: "medium",
  status: "in-progress",
  tags: [],
  title: `Sample ${id}`,
  ...options,
});

const record: CreateBoardRecord = {
  body: "Inspect the independent sample.",
  dependsOn: [13],
  kind: "follow-up",
  lifecycle: "sample-delivery",
  operationKey: JSON.stringify([
    "task-12",
    "task-12:review:1",
    "follow-up",
    "sample-operation",
  ]),
  parent: 10,
  priority: "high",
  status: "backlog",
  title: "Inspect another sample",
};

const source = {
  instanceId: "task-12",
  sessionKey: "task-12:review:1",
  taskId: 12,
};

const boardTask = (id = 21): BoardTask => {
  const identity = boardRecordIdentity(record);
  return task(id, {
    body: record.body,
    dependencies: record.dependsOn,
    lifecycle: record.lifecycle,
    parent: record.parent,
    priority: record.priority,
    status: record.status,
    tags: [
      `type:${record.kind}`,
      `lifecycle:${record.lifecycle}`,
      `heddle-operation:${identity.operationDigest}`,
      `heddle-record:${identity.recordDigest}`,
    ],
    title: record.title,
  });
};

const attentionFixture = () => {
  const records = new Map<string, ProductionErrorAttention>();
  return {
    attention: {
      has: async (attentionId: string) => records.has(attentionId),
      raise: async (attention: ProductionErrorAttention) => {
        records.set(attention.attentionId, attention);
      },
      resolve: (attentionId: string) => records.delete(attentionId),
    },
    records,
  };
};

const pendingIntent = (
  persistence: SqlitePersistence,
  request: Record<string, unknown> = {
    body: record.body,
    dependsOn: record.dependsOn,
    operationKey: record.operationKey,
    priority: record.priority,
    status: record.status,
    title: record.title,
  },
) => {
  const identity = boardRecordIdentity(record);
  return persistence.recordDynamicTaskIntent({
    kind: record.kind,
    lifecycle: record.lifecycle,
    operationDigest: identity.operationDigest,
    parentEpicId: record.parent,
    recordDigest: identity.recordDigest,
    request: request as never,
    sourceInstanceId: source.instanceId,
    sourceSessionKey: source.sessionKey,
    sourceTaskId: source.taskId,
  }).record;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("DynamicTaskAuthority", () => {
  it("writes authority before the board effect and rejects changed replay before another effect", async () => {
    const persistence = await makePersistence();
    const attention = attentionFixture();
    const tasks = [
      task(10, { tags: ["type:epic"] }),
      task(12, { parent: 10 }),
      task(13, { parent: 10 }),
    ];
    const createRecord = vi.fn(async () => {
      expect(persistence.listDynamicTaskIntents("pending")).toHaveLength(1);
      const created = boardTask();
      tasks.push(created);
      return { replayed: false, task: created };
    });
    const board = {
      createRecord,
      readBoard: async () => tasks,
      readTask: async (id: number) => tasks.find((value) => value.id === id)!,
    };
    const authority = new DynamicTaskAuthority(
      persistence,
      board,
      attention.attention,
    );

    await expect(authority.createRecord(record, source)).resolves.toMatchObject(
      {
        replayed: false,
        task: { id: 21 },
      },
    );
    expect(persistence.listDynamicTaskIntents("completed")).toMatchObject([
      { sourceTaskId: 12, state: "completed", taskId: 21 },
    ]);
    await expect(authority.createRecord(record, source)).resolves.toMatchObject(
      {
        replayed: true,
        task: { id: 21 },
      },
    );
    await expect(
      authority.createRecord({ ...record, title: "Changed sample" }, source),
    ).rejects.toThrow("changed durable identity");
    expect(createRecord).toHaveBeenCalledTimes(1);
    persistence.close();
  });

  it("keeps zero-match recovery quiet and binds exactly one complete match", async () => {
    const persistence = await makePersistence();
    const intent = pendingIntent(persistence);
    const attention = attentionFixture();
    const tasks: BoardTask[] = [];
    const authority = new DynamicTaskAuthority(
      persistence,
      {
        createRecord: vi.fn(),
        readBoard: async () => tasks,
        readTask: vi.fn(),
      },
      attention.attention,
    );

    await authority.recoverPending();
    expect(attention.records).toHaveLength(0);
    expect(
      persistence.getDynamicTaskIntent(intent.operationDigest),
    ).toMatchObject({
      state: "pending",
    });

    tasks.push(boardTask());
    await authority.recoverPending();
    expect(
      persistence.getDynamicTaskIntent(intent.operationDigest),
    ).toMatchObject({
      state: "completed",
      taskId: 21,
    });
    expect(authority.verifyTask(tasks[0]!)).toMatchObject({ taskId: 21 });
    persistence.close();
  });

  it.each([
    [
      "conflicting",
      [boardTask(21)].map((value) => ({ ...value, body: "Changed" })),
    ],
    ["ambiguous", [boardTask(21), boardTask(22)]],
  ] as const)(
    "fails %s recovery closed with one stable attention",
    async (failure, boardTasks) => {
      const persistence = await makePersistence();
      pendingIntent(persistence);
      const attention = attentionFixture();
      const authority = new DynamicTaskAuthority(
        persistence,
        {
          createRecord: vi.fn(),
          readBoard: async () => [...boardTasks],
          readTask: vi.fn(),
        },
        attention.attention,
      );

      await authority.recoverPending();
      await authority.recoverPending();

      expect(persistence.listDynamicTaskIntents("pending")).toHaveLength(1);
      expect([...attention.records.values()]).toMatchObject([
        { code: `dynamic-task-authority-${failure}`, taskId: 10 },
      ]);
      persistence.close();
    },
  );

  it("raises stable malformed and board-failure recovery attention", async () => {
    const malformedPersistence = await makePersistence();
    pendingIntent(malformedPersistence, { title: "Missing fields" });
    const malformedAttention = attentionFixture();
    const malformed = new DynamicTaskAuthority(
      malformedPersistence,
      {
        createRecord: vi.fn(),
        readBoard: async () => [boardTask()],
        readTask: vi.fn(),
      },
      malformedAttention.attention,
    );
    await malformed.recoverPending();
    expect([...malformedAttention.records.values()]).toMatchObject([
      { code: "dynamic-task-authority-malformed" },
    ]);
    malformedPersistence.close();

    const failedPersistence = await makePersistence();
    pendingIntent(failedPersistence);
    const failedAttention = attentionFixture();
    const failed = new DynamicTaskAuthority(
      failedPersistence,
      {
        createRecord: vi.fn(),
        readBoard: () => Promise.reject(new Error("Injected board failure")),
        readTask: vi.fn(),
      },
      failedAttention.attention,
    );
    await failed.recoverPending();
    expect([...failedAttention.records.values()]).toMatchObject([
      { code: "dynamic-task-authority-failed" },
    ]);
    failedPersistence.close();
  });
});
