// ---
// relationships:
//   implements: heddle
// ---

import { createHash } from "node:crypto";

import { KanbanBoardStore, type StoredTask } from "../board-store/index.js";
import type { JsonValue } from "../persistence/index.js";
import {
  parseTaskProviderAliasMap,
  type TaskProviderAliasMap,
} from "../provider-alias.js";
import { epicControlForStatus } from "./epic-control.js";

const lifecycleName = /^[a-z][a-z-]*$/;
const repositoryIdentifier = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface BoardTask {
  blocked: boolean;
  frontMatter: JsonValue;
  id: number;
  title: string;
  status: string;
  priority: string;
  tags: string[];
  dependencies: number[];
  parent?: number;
  lifecycle?: string;
  providerAlias?: TaskProviderAliasMap;
  repos?: string[];
}

export interface CreateBoardRecord {
  kind: "finding" | "follow-up";
  title: string;
  body: string;
  parent: number;
  lifecycle: string;
  operationKey: string;
  dependsOn?: number[];
  priority?: string;
  repos?: string[];
  status?: string;
}

export interface BoardRecordWriteResult {
  replayed: boolean;
  task: BoardTask;
}

export interface BoardRecordIdentity {
  operationDigest: string;
  recordDigest: string;
}

export class EpicStatusConflictError extends Error {
  public constructor(
    public readonly taskId: number,
    public readonly currentStatus: string,
    public readonly requestedStatus: "in-progress" | "todo",
  ) {
    super(
      `epic ${taskId} cannot transition from ${currentStatus} to ${requestedStatus}`,
    );
    this.name = "EpicStatusConflictError";
  }
}

export const isRepositoryScope = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (repository): repository is string =>
      typeof repository === "string" && repositoryIdentifier.test(repository),
  ) &&
  new Set(value).size === value.length;

const requireRepositories = (value: unknown): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!isRepositoryScope(value)) {
    throw new Error("board task declares an invalid repository scope");
  }
  return value;
};

const lifecycleFromTag = (tags: string[]): string | undefined => {
  const values = tags
    .filter((tag) => tag.startsWith("lifecycle:"))
    .map((tag) => tag.slice("lifecycle:".length));
  if (values.length > 1) {
    throw new Error("task has more than one lifecycle tag");
  }
  return values[0];
};

const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(value as Record<string, unknown>).every(isJsonValue)
  );
};

/**
 * Exposes the whole front matter, including properties Heddle does not own, so
 * callers read a board field without the board layer having to know about it.
 */
const taskFrontMatter = (task: StoredTask): Record<string, JsonValue> => {
  const value = task.document.frontMatter.toJSON() as unknown;
  if (!isJsonValue(value) || Array.isArray(value) || value === null) {
    throw new Error("task front matter must be a JSON-compatible object");
  }
  return value as Record<string, JsonValue>;
};

const lifecycleFromFrontMatter = (
  frontMatter: Record<string, JsonValue>,
): string | undefined => {
  const value = frontMatter["lifecycle"];
  return typeof value === "string" ? value.trim() : undefined;
};

const validateLifecycle = (value: string | undefined): string | undefined => {
  if (value !== undefined && !lifecycleName.test(value)) {
    throw new Error(`invalid lifecycle name: ${value}`);
  }
  return value;
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const operationTag = (operationDigest: string): string =>
  `heddle-operation:${operationDigest}`;

const recordDigest = (
  record: Omit<CreateBoardRecord, "operationKey">,
): string =>
  sha256(
    JSON.stringify({
      body: record.body,
      dependsOn: record.dependsOn ?? [],
      kind: record.kind,
      lifecycle: record.lifecycle,
      parent: record.parent,
      priority: record.priority ?? null,
      status: record.status ?? null,
      title: record.title,
      ...(record.repos === undefined ? {} : { repos: record.repos }),
    }),
  );

const recordTag = (digest: string): string => `heddle-record:${digest}`;

export const boardRecordIdentity = (
  record: CreateBoardRecord,
): BoardRecordIdentity => ({
  operationDigest: sha256(record.operationKey),
  recordDigest: recordDigest(record),
});

export const boardTaskMatchesRecord = (
  task: BoardTask,
  record: Omit<CreateBoardRecord, "operationKey">,
  identity: BoardRecordIdentity,
): boolean =>
  task.lifecycle === record.lifecycle &&
  task.parent === record.parent &&
  task.tags.includes(`type:${record.kind}`) &&
  task.tags.includes(operationTag(identity.operationDigest)) &&
  task.tags.includes(recordTag(identity.recordDigest)) &&
  // The digest binds declared repos, while this ordered check also rejects a
  // scoped board task when an older durable record declared no scope.
  (task.repos ?? []).length === (record.repos ?? []).length &&
  (task.repos ?? []).every(
    (repository, index) => repository === (record.repos ?? [])[index],
  ) &&
  recordDigest(record) === identity.recordDigest;

export class KanbanBoardAdapter {
  private activityWriteQueue: Promise<void> = Promise.resolve();
  private recordWriteQueue: Promise<void> = Promise.resolve();

  private readonly store: KanbanBoardStore;

  public constructor(boardDirectory: string) {
    this.store = new KanbanBoardStore(boardDirectory);
  }

  public async readBoard(): Promise<BoardTask[]> {
    return (await this.store.listTasks()).map((task) =>
      this.normalizeTask(task),
    );
  }

  public async readBoardStatuses(): Promise<string[]> {
    return this.store.readBoardStatuses();
  }

  public async readTask(taskId: number): Promise<BoardTask> {
    return this.normalizeTask(await this.store.readTask(taskId));
  }

  public async mirrorTaskStatus(taskId: number, status: string): Promise<void> {
    const task = await this.readTask(taskId);
    if (task.tags.includes("type:epic")) {
      throw new Error(`task ${taskId} is an epic task`);
    }
    await this.store.editTaskStatus(taskId, status);
  }

  public appendTaskActivity(
    taskId: number,
    operationKey: string,
    activity: string,
  ): Promise<boolean> {
    if (operationKey.trim() === "") {
      return Promise.reject(new Error("board activity operation key is empty"));
    }
    if (activity.trim() === "") {
      return Promise.reject(new Error("board activity is empty"));
    }
    const write = this.activityWriteQueue.then(
      () => this.writeTaskActivity(taskId, operationKey, activity),
      () => this.writeTaskActivity(taskId, operationKey, activity),
    );
    this.activityWriteQueue = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  public async transitionEpicStatus(
    taskId: number,
    status: "done" | "uat",
  ): Promise<void> {
    if (status !== "uat" && status !== "done") {
      throw new Error(`epic status transition is not allowed: ${status}`);
    }
    const task = await this.readTask(taskId);
    if (task.parent !== undefined || !task.tags.includes("type:epic")) {
      throw new Error(`task ${taskId} is not an epic task`);
    }
    await this.store.editTaskStatus(taskId, status);
  }

  public async setEpicInProgress(
    taskId: number,
    inProgress: boolean,
  ): Promise<void> {
    const task = await this.readTask(taskId);
    if (task.parent !== undefined || !task.tags.includes("type:epic")) {
      throw new Error(`task ${taskId} is not an epic task`);
    }
    const requestedControl = inProgress ? "start" : "pause";
    const requestedStatus = inProgress ? "in-progress" : "todo";
    if (epicControlForStatus(task.status) !== requestedControl) {
      throw new EpicStatusConflictError(taskId, task.status, requestedStatus);
    }
    await this.store.editTaskStatus(taskId, requestedStatus);
  }

  public createRecord(
    record: CreateBoardRecord,
  ): Promise<BoardRecordWriteResult> {
    if (record.operationKey.trim() === "") {
      return Promise.reject(new Error("board record operation key is empty"));
    }
    const write = this.recordWriteQueue.then(
      () => this.writeRecord(record),
      () => this.writeRecord(record),
    );
    this.recordWriteQueue = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  private async writeRecord(
    record: CreateBoardRecord,
  ): Promise<BoardRecordWriteResult> {
    validateLifecycle(record.lifecycle);
    requireRepositories(record.repos);
    const identity = boardRecordIdentity(record);
    const occurrenceTag = operationTag(identity.operationDigest);
    const requestTag = recordTag(identity.recordDigest);
    const matches = (await this.readBoard()).filter(({ tags }) =>
      tags.includes(occurrenceTag),
    );
    if (matches.length > 1) {
      throw new Error(
        `Board record operation '${record.operationKey}' has more than one board task`,
      );
    }
    if (matches.length === 1) {
      const existing = matches[0]!;
      if (!boardTaskMatchesRecord(existing, record, identity)) {
        throw new Error(
          `Board record operation '${record.operationKey}' does not match its existing board task`,
        );
      }
      return { replayed: true, task: existing };
    }
    const parent = await this.readTask(record.parent);
    if (parent.parent !== undefined || !parent.tags.includes("type:epic")) {
      throw new Error(`board record parent ${record.parent} is not an epic`);
    }
    for (const dependencyId of record.dependsOn ?? []) {
      const dependency = await this.readTask(dependencyId);
      if (dependency.parent !== record.parent) {
        throw new Error(
          `board record dependency ${dependencyId} is not a child of epic ${record.parent}`,
        );
      }
    }
    // Repository scope is an ordinary front-matter property Heddle writes and
    // reads; the board format does not have to know the field exists.
    const created = await this.store.createTask({
      body: record.body,
      parent: record.parent,
      tags: [
        `type:${record.kind}`,
        `lifecycle:${record.lifecycle}`,
        occurrenceTag,
        requestTag,
      ],
      title: record.title,
      ...(record.dependsOn === undefined || record.dependsOn.length === 0
        ? {}
        : { dependsOn: record.dependsOn }),
      ...(record.priority === undefined ? {} : { priority: record.priority }),
      ...(record.repos === undefined
        ? {}
        : { properties: { repos: record.repos } }),
      ...(record.status === undefined ? {} : { status: record.status }),
    });
    return { replayed: false, task: this.normalizeTask(created) };
  }

  private async writeTaskActivity(
    taskId: number,
    operationKey: string,
    activity: string,
  ): Promise<boolean> {
    const marker = `<!-- heddle-activity:${sha256(operationKey)} -->`;
    const task = await this.store.readTask(taskId);
    if (task.document.body.includes(marker)) return false;
    await this.store.appendTaskBody(taskId, `${activity.trim()}\n${marker}`);
    return true;
  }

  private normalizeTask(task: StoredTask): BoardTask {
    const frontMatter = taskFrontMatter(task);
    const lifecycle = validateLifecycle(
      lifecycleFromFrontMatter(frontMatter) ?? lifecycleFromTag(task.tags),
    );
    const providerAlias = parseTaskProviderAliasMap(
      frontMatter["provider-alias"],
      task.id,
    );
    const repos = requireRepositories(frontMatter["repos"]);
    return {
      blocked: task.blocked,
      frontMatter,
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      tags: task.tags,
      dependencies: task.dependsOn,
      ...(task.parent === undefined ? {} : { parent: task.parent }),
      lifecycle,
      ...(providerAlias === undefined ? {} : { providerAlias }),
      ...(repos === undefined ? {} : { repos }),
    };
  }
}
