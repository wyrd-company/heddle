// ---
// relationships:
//   implements: heddle
// ---

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const lifecycleName = /^[a-z][a-z-]*$/;

export type KanbanCommandRunner = (arguments_: string[]) => Promise<string>;

export interface BoardTask {
  blocked: boolean;
  id: number;
  title: string;
  status: string;
  priority: string;
  tags: string[];
  dependencies: number[];
  parent?: number;
  lifecycle?: string;
}

export interface CreateBoardRecord {
  kind: "finding" | "follow-up";
  title: string;
  body: string;
  parent: number;
  lifecycle: string;
  dependsOn?: number[];
  priority?: string;
  status?: string;
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

const lifecycleFromFrontMatter = (source: string): string | undefined => {
  if (!source.startsWith("---\n")) return undefined;
  const end = source.indexOf("\n---", 4);
  if (end === -1) return undefined;
  const frontMatter = source.slice(4, end);
  const match = /^lifecycle:\s*(.*?)\s*$/m.exec(frontMatter);
  return match?.[1] === undefined ? undefined : unquoteScalar(match[1]);
};

const validateLifecycle = (value: string | undefined): string | undefined => {
  if (value !== undefined && !lifecycleName.test(value)) {
    throw new Error(`invalid lifecycle name: ${value}`);
  }
  return value;
};

export class KanbanBoardAdapter {
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

  public async readTask(taskId: number): Promise<BoardTask> {
    const output = await this.command("show", String(taskId), "--json");
    return this.normalizeTask(requireTask(parseJson(output)));
  }

  public async mirrorChildStatus(
    taskId: number,
    status: string,
  ): Promise<void> {
    const task = await this.readTask(taskId);
    if (task.parent === undefined) {
      throw new Error(`task ${taskId} is not a child task`);
    }
    await this.command("edit", String(taskId), "--status", status, "--json");
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

  public async createRecord(record: CreateBoardRecord): Promise<BoardTask> {
    validateLifecycle(record.lifecycle);
    const arguments_ = [
      "create",
      record.title,
      "--body",
      record.body,
      "--parent",
      String(record.parent),
      "--tags",
      `type:${record.kind},lifecycle:${record.lifecycle}`,
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
    return this.normalizeTask(created);
  }

  private async normalizeTask(task: KanbanTaskJson): Promise<BoardTask> {
    const tags = task.tags ?? [];
    const source = await readFile(task.file, "utf8");
    const lifecycle = validateLifecycle(
      lifecycleFromFrontMatter(source) ?? lifecycleFromTag(tags),
    );
    return {
      blocked: task.blocked ?? false,
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      tags,
      dependencies: task.depends_on ?? [],
      parent: task.parent,
      lifecycle,
    };
  }

  private command(...arguments_: string[]): Promise<string> {
    return this.run(["--dir", this.boardDirectory, ...arguments_]);
  }
}
