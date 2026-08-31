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

const executeFile = promisify(execFile);
const lifecycleName = /^[a-z][a-z-]*$/;

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
  product?: string;
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
  status?: string;
}

export interface BoardRecordWriteResult {
  replayed: boolean;
  task: BoardTask;
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
  return value as KanbanTaskJson;
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

const scalarFromFrontMatter = (
  frontMatter: string | undefined,
  key: string,
): string | undefined => {
  if (frontMatter === undefined) return undefined;
  const match = new RegExp(`^${key}:\\s*(.*?)\\s*$`, "m").exec(frontMatter);
  return match?.[1] === undefined ? undefined : unquoteScalar(match[1]);
};

const lifecycleFromFrontMatter = (source: string): string | undefined => {
  const frontMatter = frontMatterFrom(source);
  if (frontMatter === undefined) return undefined;
  const match = /^lifecycle:\s*(.*?)\s*$/m.exec(frontMatter);
  return match?.[1] === undefined ? undefined : unquoteScalar(match[1]);
};

const repositoriesFromFrontMatter = (
  frontMatter: string | undefined,
): string[] | undefined => {
  if (frontMatter === undefined) return undefined;
  const lines = frontMatter.split("\n");
  const index = lines.findIndex((line) => /^repos:\s*/.test(line));
  if (index === -1) return undefined;
  const inline = lines[index]!.replace(/^repos:\s*/, "").trim();
  let values: string[];
  if (inline !== "") {
    if (!inline.startsWith("[") || !inline.endsWith("]")) {
      throw new Error("task repos declaration must be a YAML list");
    }
    const body = inline.slice(1, -1).trim();
    values = body === "" ? [] : body.split(",").map(unquoteScalar);
  } else {
    values = [];
    for (const line of lines.slice(index + 1)) {
      if (/^[^ \t]/.test(line)) break;
      if (line.trim() === "") continue;
      const item = /^\s+-\s+(.+?)\s*$/.exec(line)?.[1];
      if (item === undefined) {
        throw new Error("task repos declaration must be a YAML list");
      }
      values.push(unquoteScalar(item));
    }
  }
  if (
    values.length === 0 ||
    values.some((value) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) ||
    new Set(values).size !== values.length
  ) {
    throw new Error("task repos declaration must name unique repositories");
  }
  return values;
};

const validateLifecycle = (value: string | undefined): string | undefined => {
  if (value !== undefined && !lifecycleName.test(value)) {
    throw new Error(`invalid lifecycle name: ${value}`);
  }
  return value;
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const operationTag = (operationKey: string): string =>
  `heddle-operation:${sha256(operationKey)}`;

const recordTag = (record: CreateBoardRecord): string =>
  `heddle-record:${sha256(
    JSON.stringify({
      body: record.body,
      dependsOn: record.dependsOn ?? [],
      kind: record.kind,
      lifecycle: record.lifecycle,
      parent: record.parent,
      priority: record.priority ?? null,
      status: record.status ?? null,
      title: record.title,
    }),
  )}`;

export class KanbanBoardAdapter {
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
    await this.command(
      "edit",
      String(taskId),
      "--status",
      inProgress ? "in-progress" : "todo",
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
    const occurrenceTag = operationTag(record.operationKey);
    const requestTag = recordTag(record);
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
      if (!existing.tags.includes(requestTag)) {
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

  private async normalizeTask(task: KanbanTaskJson): Promise<BoardTask> {
    const tags = task.tags ?? [];
    const source = await readFile(task.file, "utf8");
    const frontMatter = frontMatterFrom(source);
    const lifecycle = validateLifecycle(
      lifecycleFromFrontMatter(source) ?? lifecycleFromTag(tags),
    );
    const product = scalarFromFrontMatter(frontMatter, "product");
    if (product !== undefined && product.trim() === "") {
      throw new Error("task product declaration must not be empty");
    }
    const repos = repositoriesFromFrontMatter(frontMatter);
    return {
      blocked: task.blocked ?? false,
      frontMatter: rawFrontMatter(frontMatter),
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      tags,
      dependencies: task.depends_on ?? [],
      parent: task.parent,
      lifecycle,
      ...(product === undefined ? {} : { product }),
      ...(repos === undefined ? {} : { repos }),
    };
  }

  private command(...arguments_: string[]): Promise<string> {
    return this.run(["--dir", this.boardDirectory, ...arguments_]);
  }
}
