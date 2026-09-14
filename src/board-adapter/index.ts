// ---
// relationships:
//   implements: heddle
// ---

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { parse } from "yaml";

import type { JsonValue } from "../persistence/index.js";
import {
  parseTaskProviderAliasMap,
  type TaskProviderAliasMap,
} from "../provider-alias.js";
import { epicControlForStatus } from "./epic-control.js";

const executeFile = promisify(execFile);
const lifecycleName = /^[a-z][a-z-]*$/;
const repositoryIdentifier = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type KanbanCommandRunner = (arguments_: string[]) => Promise<string>;

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

interface KanbanTaskJson {
  blocked?: boolean;
  id: number;
  title: string;
  status: string;
  priority: string;
  tags?: string[];
  parent?: number;
  depends_on?: number[];
  repos?: string[];
  file: string;
}

interface KanbanBoardJson {
  statuses: Array<{ status: string }>;
}

const defaultRunner: KanbanCommandRunner = async (arguments_) => {
  const result = await executeFile("kanban-md", arguments_, {
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout;
};

const parseJson = (output: string): unknown => JSON.parse(output) as unknown;

const requireTask = (value: unknown): KanbanTaskJson => {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as KanbanTaskJson).id !== "number" ||
    typeof (value as KanbanTaskJson).title !== "string" ||
    typeof (value as KanbanTaskJson).status !== "string" ||
    typeof (value as KanbanTaskJson).priority !== "string" ||
    typeof (value as KanbanTaskJson).file !== "string" ||
    ((value as KanbanTaskJson).blocked !== undefined &&
      typeof (value as KanbanTaskJson).blocked !== "boolean")
  ) {
    throw new Error("kanban-md returned an invalid task");
  }
  requireRepositories((value as KanbanTaskJson).repos);
  return value as KanbanTaskJson;
};

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
    throw new Error("kanban-md returned an invalid task repository scope");
  }
  return value;
};

const requireBoardStatuses = (value: unknown): string[] => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("statuses" in value) ||
    !Array.isArray(value.statuses) ||
    !value.statuses.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        "status" in item &&
        typeof item.status === "string",
    )
  ) {
    throw new Error("kanban-md returned an invalid board");
  }
  return (value as KanbanBoardJson).statuses.map(({ status }) => status);
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

const unquoteScalar = (value: string): string => {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const frontMatterFrom = (source: string): string | undefined => {
  if (!source.startsWith("---\n")) return undefined;
  const end = source.indexOf("\n---", 4);
  if (end === -1) return undefined;
  return source.slice(4, end);
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

const rawFrontMatter = (serialized: string | undefined): JsonValue => {
  if (serialized === undefined) {
    throw new Error("task has no YAML front matter");
  }
  let value: unknown;
  try {
    value = parse(serialized);
  } catch (error) {
    throw new Error(
      `task front matter is invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isJsonValue(value) || Array.isArray(value) || value === null) {
    throw new Error("task front matter must be a JSON-compatible object");
  }
  return value;
};

const lifecycleFromFrontMatter = (source: string): string | undefined => {
  const frontMatter = frontMatterFrom(source);
  if (frontMatter === undefined) return undefined;
  const match = /^lifecycle:\s*(.*?)\s*$/m.exec(frontMatter);
  return match?.[1] === undefined ? undefined : unquoteScalar(match[1]);
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

  public constructor(
    private readonly boardDirectory: string,
    private readonly run: KanbanCommandRunner = defaultRunner,
  ) {}

  public async readBoard(): Promise<BoardTask[]> {
    const output = await this.command("list", "--json");
    const value = parseJson(output);
    if (!Array.isArray(value)) {
      throw new Error("kanban-md returned an invalid task list");
    }
    return Promise.all(
      value.map((task) => this.normalizeTask(requireTask(task))),
    );
  }

  public async readBoardStatuses(): Promise<string[]> {
    return requireBoardStatuses(
      parseJson(await this.command("board", "--json")),
    );
  }

  public async readTask(taskId: number): Promise<BoardTask> {
    const output = await this.command("show", String(taskId), "--json");
    return this.normalizeTask(requireTask(parseJson(output)));
  }

  public async mirrorTaskStatus(taskId: number, status: string): Promise<void> {
    const task = await this.readTask(taskId);
    if (task.tags.includes("type:epic")) {
      throw new Error(`task ${taskId} is an epic task`);
    }
    await this.command("edit", String(taskId), "--status", status, "--json");
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
    await this.command("edit", String(taskId), "--status", status, "--json");
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
    await this.command(
      "edit",
      String(taskId),
      "--status",
      requestedStatus,
      "--json",
    );
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
    const arguments_ = [
      "create",
      record.title,
      "--body",
      record.body,
      "--parent",
      String(record.parent),
      "--tags",
      `type:${record.kind},lifecycle:${record.lifecycle},${occurrenceTag},${requestTag}`,
    ];
    if (record.dependsOn !== undefined && record.dependsOn.length > 0) {
      arguments_.push("--depends-on", record.dependsOn.join(","));
    }
    if (record.repos !== undefined) {
      arguments_.push("--repos", record.repos.join(","));
    }
    if (record.priority !== undefined) {
      arguments_.push("--priority", record.priority);
    }
    if (record.status !== undefined) {
      arguments_.push("--status", record.status);
    }
    arguments_.push("--json");

    const created = requireTask(parseJson(await this.command(...arguments_)));
    return { replayed: false, task: await this.normalizeTask(created) };
  }

  private async writeTaskActivity(
    taskId: number,
    operationKey: string,
    activity: string,
  ): Promise<boolean> {
    const marker = `<!-- heddle-activity:${sha256(operationKey)} -->`;
    const task = requireTask(
      parseJson(await this.command("show", String(taskId), "--json")),
    );
    const source = await readFile(task.file, "utf8");
    if (source.includes(marker)) return false;
    await this.command(
      "edit",
      String(taskId),
      "--append-body",
      `${activity.trim()}\n${marker}`,
      "--json",
    );
    return true;
  }

  private async normalizeTask(task: KanbanTaskJson): Promise<BoardTask> {
    const tags = task.tags ?? [];
    const source = await readFile(task.file, "utf8");
    const frontMatter = frontMatterFrom(source);
    const lifecycle = validateLifecycle(
      lifecycleFromFrontMatter(source) ?? lifecycleFromTag(tags),
    );
    const parsedFrontMatter = rawFrontMatter(frontMatter);
    const providerAlias = parseTaskProviderAliasMap(
      (parsedFrontMatter as Record<string, JsonValue>)["provider-alias"],
      task.id,
    );
    const declaredRepos = requireRepositories(
      (parsedFrontMatter as Record<string, JsonValue>)["repos"],
    );
    const repos = task.repos;
    if (
      (declaredRepos ?? []).length !== (repos ?? []).length ||
      !(declaredRepos ?? []).every(
        (repository, index) => repository === (repos ?? [])[index],
      )
    ) {
      throw new Error(
        `kanban-md typed repository scope disagrees with task ${task.id} front matter`,
      );
    }
    return {
      blocked: task.blocked ?? false,
      frontMatter: parsedFrontMatter,
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      tags,
      dependencies: task.depends_on ?? [],
      parent: task.parent,
      lifecycle,
      ...(providerAlias === undefined ? {} : { providerAlias }),
      ...(repos === undefined ? {} : { repos }),
    };
  }

  private command(...arguments_: string[]): Promise<string> {
    return this.run(["--dir", this.boardDirectory, ...arguments_]);
  }
}
