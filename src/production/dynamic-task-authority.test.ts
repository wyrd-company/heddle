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
  const raise = vi.fn(async (attention: ProductionErrorAttention) => {
    records.set(attention.attentionId, attention);
  });
  return {
    attention: {
      has: async (attentionId: string) => records.has(attentionId),
      raise,
      resolve: (attentionId: string) => records.delete(attentionId),
    },
    raise,
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
  it("routes creation and recovery through the same parent epic boundary", async () => {
    const createPersistence = await makePersistence();
    const createAttention = attentionFixture();
    const createTasks = [
      task(10, { tags: ["type:epic"] }),
      task(12, { parent: 10 }),
      task(13, { parent: 10 }),
    ];
    const boundaryKeys: number[] = [];
    const epicOperations = {
      run: async <T>(epicId: number, operation: () => Promise<T>) => {
        boundaryKeys.push(epicId);
        return operation();
      },
    };
    const createAuthority = new DynamicTaskAuthority(
      createPersistence,
      {
        createRecord: async () => ({ replayed: false, task: boardTask() }),
        readBoard: async () => createTasks,
        readTask: async (id: number) =>
          createTasks.find((value) => value.id === id)!,
      },
      createAttention.attention,
      { epicOperations },
    );

    await createAuthority.createRecord(record, source);

    const recoveryPersistence = await makePersistence();
    pendingIntent(recoveryPersistence);
    const recoveryAuthority = new DynamicTaskAuthority(
      recoveryPersistence,
      {
        createRecord: vi.fn(),
        readBoard: async () => [],
        readTask: vi.fn(),
      },
      attentionFixture().attention,
      { epicOperations },
    );
    await recoveryAuthority.recoverPending();

    expect(boundaryKeys).toEqual([record.parent, record.parent]);
    createPersistence.close();
    recoveryPersistence.close();
  });

  it("rejects creation after its parent epic is complete", async () => {
    const persistence = await makePersistence();
    const attention = attentionFixture();
    const tasks = [
      task(10, { status: "done", tags: ["type:epic"] }),
      task(12, { parent: 10, status: "done" }),
      task(13, { parent: 10, status: "done" }),
    ];
    const createRecord = vi.fn();
    const authority = new DynamicTaskAuthority(
      persistence,
      {
        createRecord,
        readBoard: async () => tasks,
        readTask: async (id: number) => tasks.find((value) => value.id === id)!,
      },
      attention.attention,
    );

    await expect(authority.createRecord(record, source)).rejects.toThrow(
      "parent epic 10 is already done",
    );
    expect(createRecord).not.toHaveBeenCalled();
    expect(persistence.listDynamicTaskIntents()).toHaveLength(0);
    persistence.close();
  });

  it("returns an exact completed replay after its parent epic completes", async () => {
    const persistence = await makePersistence();
    const attention = attentionFixture();
    const tasks = [
      task(10, { tags: ["type:epic"] }),
      task(12, { parent: 10 }),
      task(13, { parent: 10 }),
    ];
    const createRecord = vi.fn(async () => {
      const created = boardTask();
      tasks.push(created);
      return { replayed: false, task: created };
    });
    const authority = new DynamicTaskAuthority(
      persistence,
      {
        createRecord,
        readBoard: async () => tasks,
        readTask: async (id: number) => tasks.find((value) => value.id === id)!,
      },
      attention.attention,
    );
    await authority.createRecord(record, source);
    tasks[0]!.status = "done";

    await expect(authority.createRecord(record, source)).resolves.toMatchObject(
      {
        replayed: true,
        task: { id: 21 },
      },
    );
    expect(createRecord).toHaveBeenCalledTimes(1);
    persistence.close();
  });

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
    board.readTask = async (id: number) =>
      id === 21 ? boardTask(22) : tasks.find((value) => value.id === id)!;
    await expect(authority.createRecord(record, source)).rejects.toThrow(
      "Board task 22 does not exactly match",
    );
    board.readTask = async (id: number) =>
      tasks.find((value) => value.id === id)!;
    await expect(
      authority.createRecord({ ...record, title: "Changed sample" }, source),
    ).rejects.toThrow("changed durable identity");
    await expect(
      authority.createRecord(
        {
          ...record,
          operationKey: JSON.stringify([
            "task-12",
            "task-12:other:1",
            "follow-up",
            "different-operation",
          ]),
        },
        source,
      ),
    ).rejects.toThrow("source identity does not match its operation");
    expect(createRecord).toHaveBeenCalledTimes(1);
    expect(persistence.listDynamicTaskIntents()).toHaveLength(1);
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

    expect(authority.verifyTask(boardTask())).toBeUndefined();
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
      "record identity from another operation",
      () => {
        const otherIdentity = boardRecordIdentity({
          ...record,
          operationKey: JSON.stringify([
            "task-12",
            "task-12:review:1",
            "follow-up",
            "other-sample-operation",
          ]),
        });
        const otherTask = boardTask(22);
        return {
          ...otherTask,
          tags: otherTask.tags.map((tag) =>
            tag.startsWith("heddle-operation:")
              ? `heddle-operation:${otherIdentity.operationDigest}`
              : tag,
          ),
        };
      },
    ],
    [
      "operation identity from another record",
      () => {
        const otherRecord = {
          ...record,
          title: "Another independent sample",
        };
        const otherIdentity = boardRecordIdentity(otherRecord);
        const otherTask = boardTask(22);
        return {
          ...otherTask,
          tags: otherTask.tags.map((tag) =>
            tag.startsWith("heddle-record:")
              ? `heddle-record:${otherIdentity.recordDigest}`
              : tag,
          ),
          title: otherRecord.title,
        };
      },
    ],
  ] as const)(
    "binds the sole exact match despite partial %s evidence",
    async (_evidence, partialTask) => {
      const persistence = await makePersistence();
      const intent = pendingIntent(persistence);
      const attention = attentionFixture();
      const authority = new DynamicTaskAuthority(
        persistence,
        {
          createRecord: vi.fn(),
          readBoard: async () => [boardTask(21), partialTask()],
          readTask: vi.fn(),
        },
        attention.attention,
      );

      await authority.recoverPending();

      expect(
        persistence.getDynamicTaskIntent(intent.operationDigest),
      ).toMatchObject({ state: "completed", taskId: 21 });
      expect(attention.records).toHaveLength(0);
      persistence.close();
    },
  );

  it.each([
    [
      "kind",
      {
        tags: boardTask().tags.map((tag) =>
          tag === "type:follow-up" ? "type:finding" : tag,
        ),
      },
    ],
    ["parent", { parent: 11 }],
    ["lifecycle", { lifecycle: "changed-lifecycle" }],
    [
      "operation digest",
      {
        tags: boardTask().tags.map((tag) =>
          tag.startsWith("heddle-operation:")
            ? `heddle-operation:${"f".repeat(64)}`
            : tag,
        ),
      },
    ],
    [
      "record digest",
      {
        tags: boardTask().tags.map((tag) =>
          tag.startsWith("heddle-record:")
            ? `heddle-record:${"f".repeat(64)}`
            : tag,
        ),
      },
    ],
  ] as const)(
    "rejects a conflicting %s identity with one stable attention",
    async (_identity, change) => {
      const persistence = await makePersistence();
      pendingIntent(persistence);
      const attention = attentionFixture();
      const changed = { ...boardTask(), ...change };
      const authority = new DynamicTaskAuthority(
        persistence,
        {
          createRecord: vi.fn(),
          readBoard: async () => [changed],
          readTask: vi.fn(),
        },
        attention.attention,
      );

      await authority.recoverPending();
      await authority.recoverPending();

      expect(persistence.listDynamicTaskIntents("pending")).toHaveLength(1);
      expect([...attention.records.values()]).toMatchObject([
        { code: "dynamic-task-authority-conflicting", taskId: 10 },
      ]);
      expect(attention.raise).toHaveBeenCalledTimes(1);
      persistence.close();
    },
  );

  it("rejects multiple exact board identities as ambiguous", async () => {
    const persistence = await makePersistence();
    pendingIntent(persistence);
    const attention = attentionFixture();
    const authority = new DynamicTaskAuthority(
      persistence,
      {
        createRecord: vi.fn(),
        readBoard: async () => [boardTask(21), boardTask(22)],
        readTask: vi.fn(),
      },
      attention.attention,
    );

    await authority.recoverPending();
    await authority.recoverPending();

    expect([...attention.records.values()]).toMatchObject([
      { code: "dynamic-task-authority-ambiguous", taskId: 10 },
    ]);
    expect(attention.raise).toHaveBeenCalledTimes(1);
    persistence.close();
  });

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

  it.each([
    ["operation", { operationDigest: "f".repeat(64) }],
    ["record", { recordDigest: "f".repeat(64) }],
    ["source task", { sourceTaskId: 99 }],
    ["source instance", { sourceInstanceId: "task-99" }],
    ["source session", { sourceSessionKey: "task-12:other:1" }],
  ])(
    "rejects a durable %s identity that does not reproduce its request",
    async (_kind, changedIdentity) => {
      const persistence = await makePersistence();
      const identity = boardRecordIdentity(record);
      persistence.recordDynamicTaskIntent({
        kind: record.kind,
        lifecycle: record.lifecycle,
        operationDigest: identity.operationDigest,
        parentEpicId: record.parent,
        recordDigest: identity.recordDigest,
        request: {
          body: record.body,
          dependsOn: record.dependsOn,
          operationKey: record.operationKey,
          priority: record.priority,
          status: record.status,
          title: record.title,
        } as never,
        sourceInstanceId: source.instanceId,
        sourceSessionKey: source.sessionKey,
        sourceTaskId: source.taskId,
        ...changedIdentity,
      });
      const attention = attentionFixture();
      const authority = new DynamicTaskAuthority(
        persistence,
        {
          createRecord: vi.fn(),
          readBoard: async () => [boardTask()],
          readTask: vi.fn(),
        },
        attention.attention,
      );

      await authority.recoverPending();

      expect([...attention.records.values()]).toMatchObject([
        { code: "dynamic-task-authority-malformed" },
      ]);
      expect(persistence.listDynamicTaskIntents("pending")).toHaveLength(1);
      persistence.close();
    },
  );

  it("does not verify a pending row even if a malformed adapter supplies a task ID", () => {
    const identity = boardRecordIdentity(record);
    const authority = new DynamicTaskAuthority(
      {
        completeDynamicTaskIntent: vi.fn(),
        listDynamicTaskIntents: () => [
          {
            kind: record.kind,
            lifecycle: record.lifecycle,
            operationDigest: identity.operationDigest,
            parentEpicId: record.parent,
            recordDigest: identity.recordDigest,
            recordedAt: "2026-01-01T00:00:00.000Z",
            request: {
              body: record.body,
              dependsOn: record.dependsOn ?? [],
              operationKey: record.operationKey,
              priority: record.priority ?? null,
              status: record.status ?? null,
              title: record.title,
            },
            sourceInstanceId: source.instanceId,
            sourceSessionKey: source.sessionKey,
            sourceTaskId: source.taskId,
            state: "pending",
            taskId: 21,
          },
        ],
        recordDynamicTaskIntent: vi.fn(),
      },
      {
        createRecord: vi.fn(),
        readBoard: vi.fn(),
        readTask: vi.fn(),
      },
      attentionFixture().attention,
    );

    expect(authority.verifyTask(boardTask())).toBeUndefined();
  });
});
