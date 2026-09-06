// ---
// relationships:
//   implements: heddle
// ---

import {
  boardRecordIdentity,
  type BoardRecordWriteResult,
  type BoardTask,
  type CreateBoardRecord,
} from "../board-adapter/index.js";
import { errorDetail } from "../error-details.js";
import type {
  DynamicTaskIntentRecord,
  SqlitePersistence,
} from "../persistence/index.js";
import {
  dynamicTaskIntentRequest,
  dynamicTaskMatchesIntent,
  dynamicTaskOperationTag,
  dynamicTaskRecordTag,
} from "./dynamic-task-authority-identity.js";
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

type RecoveryFailure = "ambiguous" | "conflicting" | "failed" | "malformed";

const recoveryFailures: readonly RecoveryFailure[] = [
  "ambiguous",
  "conflicting",
  "failed",
  "malformed",
];

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
      request: dynamicTaskIntentRequest(record),
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
            tags.includes(dynamicTaskOperationTag(intent)) ||
            tags.includes(dynamicTaskRecordTag(intent)),
        );
        exactMatches = candidates.filter((task) =>
          dynamicTaskMatchesIntent(task, intent),
        );
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
    if (matches.length !== 1 || !dynamicTaskMatchesIntent(task, matches[0]!)) {
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
      !dynamicTaskMatchesIntent(task, intent)
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
