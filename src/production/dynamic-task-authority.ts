// ---
// relationships:
//   implements: heddle
// ---

import {
  boardRecordIdentity,
  boardTaskMatchesRecord,
  type BoardRecordWriteResult,
  type BoardTask,
  type CreateBoardRecord,
} from "../board-adapter/index.js";
import { errorDetail } from "../error-details.js";
import type {
  DynamicTaskIntentRecord,
  JsonValue,
  SqlitePersistence,
} from "../persistence/index.js";
import type { ProductionErrorAttention } from "./error-visibility.js";

type DynamicTaskSource = {
  instanceId: string;
  sessionKey: string;
  taskId: number;
};

type DynamicTaskBoard = {
  createRecord(record: CreateBoardRecord): Promise<BoardRecordWriteResult>;
  readBoard(): Promise<BoardTask[]>;
  readTask(taskId: number): Promise<BoardTask>;
};

type DynamicTaskAttention = {
  has(attentionId: string): Promise<boolean>;
  raise(attention: ProductionErrorAttention): Promise<void>;
  resolve(attentionId: string): boolean;
};

type DynamicTaskPersistence = Pick<
  SqlitePersistence,
  | "completeDynamicTaskIntent"
  | "listDynamicTaskIntents"
  | "recordDynamicTaskIntent"
>;

type StoredDynamicTaskRequest = {
  body: string;
  dependsOn: number[];
  operationKey: string;
  priority: string | null;
  status: string | null;
  title: string;
};

type RecoveryFailure = "ambiguous" | "conflicting" | "failed" | "malformed";

const recoveryFailures: readonly RecoveryFailure[] = [
  "ambiguous",
  "conflicting",
  "failed",
  "malformed",
];

const intentRequest = (
  record: CreateBoardRecord,
): StoredDynamicTaskRequest => ({
  body: record.body,
  dependsOn: record.dependsOn ?? [],
  operationKey: record.operationKey,
  priority: record.priority ?? null,
  status: record.status ?? null,
  title: record.title,
});

const requireStoredRequest = (value: JsonValue): StoredDynamicTaskRequest => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value["body"] !== "string" ||
    value["body"].trim() === "" ||
    !Array.isArray(value["dependsOn"]) ||
    !value["dependsOn"].every(
      (id) => Number.isSafeInteger(id) && (id as number) > 0,
    ) ||
    typeof value["operationKey"] !== "string" ||
    (value["priority"] !== null &&
      (typeof value["priority"] !== "string" ||
        value["priority"].trim() === "")) ||
    (value["status"] !== null &&
      (typeof value["status"] !== "string" || value["status"].trim() === "")) ||
    typeof value["title"] !== "string" ||
    value["title"].trim() === ""
  ) {
    throw new Error("Dynamic task intent request is malformed");
  }
  return value as StoredDynamicTaskRequest;
};

const recordFromIntent = (
  intent: DynamicTaskIntentRecord,
): CreateBoardRecord => {
  const request = requireStoredRequest(intent.request);
  return {
    body: request.body,
    dependsOn: request.dependsOn,
    kind: intent.kind,
    lifecycle: intent.lifecycle,
    operationKey: request.operationKey,
    parent: intent.parentEpicId,
    ...(request.priority === null ? {} : { priority: request.priority }),
    ...(request.status === null ? {} : { status: request.status }),
    title: request.title,
  };
};

const operationTag = (intent: DynamicTaskIntentRecord): string =>
  `heddle-operation:${intent.operationDigest}`;

const recordTag = (intent: DynamicTaskIntentRecord): string =>
  `heddle-record:${intent.recordDigest}`;

const matchesIntent = (
  task: BoardTask,
  intent: DynamicTaskIntentRecord,
): boolean => {
  const record = recordFromIntent(intent);
  let operation: unknown;
  try {
    operation = JSON.parse(record.operationKey) as unknown;
  } catch {
    throw new Error("Dynamic task operation key is malformed");
  }
  if (
    !/^[a-f0-9]{64}$/.test(intent.operationDigest) ||
    !/^[a-f0-9]{64}$/.test(intent.recordDigest) ||
    !/^[a-z][a-z-]*$/.test(intent.lifecycle) ||
    !Array.isArray(operation) ||
    operation.length !== 4 ||
    !operation.every((value) => typeof value === "string") ||
    operation[0] !== intent.sourceInstanceId ||
    operation[1] !== intent.sourceSessionKey ||
    operation[2] !== intent.kind ||
    operation[3]!.trim() === "" ||
    intent.sourceInstanceId !== `task-${intent.sourceTaskId}`
  ) {
    throw new Error("Dynamic task source identity is malformed");
  }
  const derived = boardRecordIdentity(record);
  if (
    derived.operationDigest !== intent.operationDigest ||
    derived.recordDigest !== intent.recordDigest
  ) {
    throw new Error("Dynamic task digest identity is malformed");
  }
  return boardTaskMatchesRecord(task, record, derived);
};

const recoveryAttention = (
  intent: DynamicTaskIntentRecord,
  failure: RecoveryFailure,
): ProductionErrorAttention => ({
  attentionId: `production:dynamic-task-authority-${failure}:task:${intent.parentEpicId}:${intent.operationDigest.slice(0, 16)}`,
  code: `dynamic-task-authority-${failure}`,
  error: errorDetail(new Error(`Dynamic task authority recovery ${failure}`)),
  instanceId: null,
  kind: "production-error",
  message: `Dynamic task authority recovery ${failure} for operation ${intent.operationDigest}.`,
  taskId: intent.parentEpicId,
});

const catalogAttention = (error: unknown): ProductionErrorAttention => ({
  attentionId: "production:dynamic-task-authority-failed:global:catalog",
  code: "dynamic-task-authority-failed",
  error: errorDetail(error),
  instanceId: null,
  kind: "production-error",
  message:
    "Dynamic task authority recovery could not read its durable catalog.",
  taskId: null,
});

export type DynamicTaskAuthorityOptions = {
  afterBoardEffect?: (task: BoardTask) => Promise<void> | void;
  afterIntentRecorded?: (
    intent: DynamicTaskIntentRecord,
  ) => Promise<void> | void;
};

export class DynamicTaskAuthority {
  public constructor(
    private readonly persistence: DynamicTaskPersistence,
    private readonly board: DynamicTaskBoard,
    private readonly attention: DynamicTaskAttention,
    private readonly options: DynamicTaskAuthorityOptions = {},
  ) {}

  public async createRecord(
    record: CreateBoardRecord,
    source: DynamicTaskSource,
  ): Promise<BoardRecordWriteResult> {
    await this.validateSource(record, source);
    const identity = boardRecordIdentity(record);
    const persisted = this.persistence.recordDynamicTaskIntent({
      kind: record.kind,
      lifecycle: record.lifecycle,
      operationDigest: identity.operationDigest,
      parentEpicId: record.parent,
      recordDigest: identity.recordDigest,
      request: intentRequest(record),
      sourceInstanceId: source.instanceId,
      sourceSessionKey: source.sessionKey,
      sourceTaskId: source.taskId,
    });
    if (persisted.record.state === "pending") {
      await this.options.afterIntentRecorded?.(persisted.record);
    }

    if (persisted.record.state === "completed") {
      const task = await this.board.readTask(persisted.record.taskId!);
      this.assertExactTask(task, persisted.record);
      return { replayed: true, task };
    }

    const write = await this.board.createRecord(record);
    this.assertExactTask(write.task, persisted.record);
    await this.options.afterBoardEffect?.(write.task);
    this.persistence.completeDynamicTaskIntent(
      persisted.record.operationDigest,
      write.task.id,
    );
    await this.resolveRecoveryAttention(persisted.record);
    return { replayed: persisted.replayed || write.replayed, task: write.task };
  }

  public readTask(taskId: number): Promise<BoardTask> {
    return this.board.readTask(taskId);
  }

  public async recoverPending(): Promise<void> {
    let pending: DynamicTaskIntentRecord[];
    try {
      pending = this.persistence.listDynamicTaskIntents("pending");
    } catch (error) {
      const attention = catalogAttention(error);
      if (!(await this.attention.has(attention.attentionId))) {
        await this.attention.raise(attention);
      }
      return;
    }
    if (pending.length === 0) return;

    let tasks: BoardTask[];
    try {
      tasks = await this.board.readBoard();
    } catch {
      for (const intent of pending) await this.raiseRecovery(intent, "failed");
      return;
    }

    for (const intent of pending) {
      let candidates: BoardTask[];
      let exactMatches: BoardTask[];
      try {
        candidates = tasks.filter(
          ({ tags }) =>
            tags.includes(operationTag(intent)) ||
            tags.includes(recordTag(intent)),
        );
        exactMatches = candidates.filter((task) => matchesIntent(task, intent));
      } catch {
        await this.raiseRecovery(intent, "malformed");
        continue;
      }
      if (candidates.length === 0) continue;
      if (exactMatches.length === 0) {
        await this.raiseRecovery(intent, "conflicting");
        continue;
      }
      if (candidates.length !== 1 || exactMatches.length !== 1) {
        await this.raiseRecovery(intent, "ambiguous");
        continue;
      }
      try {
        this.persistence.completeDynamicTaskIntent(
          intent.operationDigest,
          exactMatches[0]!.id,
        );
        await this.resolveRecoveryAttention(intent);
      } catch {
        await this.raiseRecovery(intent, "failed");
      }
    }
  }

  public verifyTask(task: BoardTask): DynamicTaskIntentRecord | undefined {
    const matches = this.persistence
      .listDynamicTaskIntents("completed")
      .filter(
        (intent) => intent.state === "completed" && intent.taskId === task.id,
      );
    if (matches.length === 0) return undefined;
    if (matches.length !== 1 || !matchesIntent(task, matches[0]!)) {
      throw new Error(
        `Task ${task.id} does not exactly match completed dynamic task authority`,
      );
    }
    return matches[0];
  }

  private async validateSource(
    record: CreateBoardRecord,
    source: DynamicTaskSource,
  ): Promise<void> {
    let operation: unknown;
    try {
      operation = JSON.parse(record.operationKey) as unknown;
    } catch {
      throw new Error("Dynamic task operation key is malformed");
    }
    if (
      !Array.isArray(operation) ||
      operation.length !== 4 ||
      !operation.every((value) => typeof value === "string") ||
      operation[0] !== source.instanceId ||
      operation[1] !== source.sessionKey ||
      operation[2] !== record.kind ||
      source.instanceId !== `task-${source.taskId}`
    ) {
      throw new Error(
        "Dynamic task source identity does not match its operation",
      );
    }
    const task = await this.board.readTask(source.taskId);
    if (task.id !== source.taskId || task.parent !== record.parent) {
      throw new Error("Dynamic task source does not match its parent epic");
    }
    const epic = await this.board.readTask(record.parent);
    if (epic.parent !== undefined || !epic.tags.includes("type:epic")) {
      throw new Error(`Dynamic task parent ${record.parent} is not an epic`);
    }
    for (const dependencyId of record.dependsOn ?? []) {
      const dependency = await this.board.readTask(dependencyId);
      if (dependency.parent !== record.parent) {
        throw new Error(
          `Dynamic task dependency ${dependencyId} is not a child of epic ${record.parent}`,
        );
      }
    }
  }

  private assertExactTask(
    task: BoardTask,
    intent: DynamicTaskIntentRecord,
  ): void {
    if (
      (intent.taskId !== undefined && task.id !== intent.taskId) ||
      !matchesIntent(task, intent)
    ) {
      throw new Error(
        `Board task ${task.id} does not exactly match dynamic task operation '${intent.operationDigest}'`,
      );
    }
  }

  private async raiseRecovery(
    intent: DynamicTaskIntentRecord,
    failure: RecoveryFailure,
  ): Promise<void> {
    const attention = recoveryAttention(intent, failure);
    if (!(await this.attention.has(attention.attentionId))) {
      await this.attention.raise(attention);
    }
  }

  private async resolveRecoveryAttention(
    intent: DynamicTaskIntentRecord,
  ): Promise<void> {
    for (const failure of recoveryFailures) {
      const attentionId = recoveryAttention(intent, failure).attentionId;
      if (await this.attention.has(attentionId)) {
        this.attention.resolve(attentionId);
      }
    }
  }
}
