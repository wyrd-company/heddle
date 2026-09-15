// ---
// relationships:
//   implements: heddle
// ---

import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { Document } from "yaml";

import {
  ARCHIVED_STATUS,
  boardStatusNames,
  persistNextId,
  readBoardConfig,
  statusNames,
  statusRequiresClaim,
  tasksPath,
  type BoardConfig,
} from "./config.js";
import { BoardStoreError } from "./errors.js";
import { renderTaskFile } from "./front-matter.js";
import {
  findTaskFileById,
  generateFilename,
  generateSlug,
  readAllTasksLenient,
  readTaskFile,
  writeTaskFile,
  type StoredTask,
} from "./task-file.js";
import { writeFileAtomic } from "./atomic-write.js";

export { BoardStoreError, type BoardStoreErrorCode } from "./errors.js";
export { ARCHIVED_STATUS } from "./config.js";
export type { StoredTask } from "./task-file.js";

/** How many ids to try before giving up when the CLI keeps winning the race. */
const ID_ALLOCATION_ATTEMPTS = 16;

/** The frontmatter key order kanban-md emits for a task it writes itself. */
const CANONICAL_KEY_ORDER = [
  "id",
  "title",
  "status",
  "priority",
  "created",
  "updated",
  "started",
  "completed",
  "assignee",
  "tags",
  "due",
  "estimate",
  "parent",
  "depends_on",
  "blocked",
  "block_reason",
  "claimed_by",
  "claimed_at",
  "class",
] as const;

export interface CreateTaskParameters {
  body?: string;
  dependsOn?: number[];
  parent?: number;
  priority?: string;
  properties?: Record<string, string[] | string>;
  status?: string;
  tags?: string[];
  title: string;
}

const timestamp = (moment: Date): string => moment.toISOString();

/**
 * Appends to a task body the way `kanban-md edit --append-body` does: the
 * existing body keeps one blank line between it and the new text.
 */
export const appendBody = (existing: string, text: string): string =>
  existing === "" ? text : `${existing.replace(/\n+$/, "")}\n\n${text}`;

/**
 * Reads and writes kanban-md task files directly.
 *
 * The on-disk shape is kanban-md's, not Heddle's: humans and agents keep using
 * the CLI against the same board. Properties this store does not own stay in
 * the file, in place, so a board field Heddle adds needs no change to the CLI.
 */
export class KanbanBoardStore {
  public constructor(private readonly boardDirectory: string) {}

  public async readBoardStatuses(): Promise<string[]> {
    return boardStatusNames(await this.config());
  }

  /** Every non-archived task, ordered by id, matching `kanban-md list`. */
  public async listTasks(): Promise<StoredTask[]> {
    const config = await this.config();
    const tasks = await readAllTasksLenient(this.tasks(config));
    return tasks
      .filter(({ status }) => status !== ARCHIVED_STATUS)
      .sort((left, right) => left.id - right.id);
  }

  public async readTask(id: number): Promise<StoredTask> {
    const config = await this.config();
    return readTaskFile(await findTaskFileById(this.tasks(config), id));
  }

  public async editTaskStatus(id: number, status: string): Promise<StoredTask> {
    const config = await this.config();
    this.requireStatus(config, status);

    const task = await this.readTask(id);
    this.requireUnclaimed(config, task);

    if (task.status === status) return task;

    // kanban-md refuses an unclaimed edit both out of and into a column that
    // requires a claim. Heddle holds no claim, so it refuses the same edits.
    if (statusRequiresClaim(config, task.status)) {
      throw new BoardStoreError(
        "claim-required",
        `status "${task.status}" requires a claim`,
      );
    }
    if (statusRequiresClaim(config, status)) {
      throw new BoardStoreError(
        "claim-required",
        `status "${status}" requires a claim`,
      );
    }
    await this.requireWipHeadroom(config, task, status);

    // `kanban-md edit --status` stamps only `updated`; `started` and
    // `completed` belong to `move`, which Heddle does not use.
    task.document.frontMatter.set("status", status);
    task.document.frontMatter.set("updated", timestamp(new Date()));
    task.status = status;

    await writeTaskFile(task);
    return task;
  }

  public async appendTaskBody(id: number, text: string): Promise<StoredTask> {
    const config = await this.config();
    const task = await this.readTask(id);
    this.requireUnclaimed(config, task);
    if (statusRequiresClaim(config, task.status)) {
      throw new BoardStoreError(
        "claim-required",
        `status "${task.status}" requires a claim`,
      );
    }

    task.document.body = appendBody(task.document.body, text);
    task.document.frontMatter.set("updated", timestamp(new Date()));

    await writeTaskFile(task);
    return task;
  }

  public async createTask(
    parameters: CreateTaskParameters,
  ): Promise<StoredTask> {
    const config = await this.config();
    const status = parameters.status ?? config.defaultStatus;
    const priority = parameters.priority ?? config.defaultPriority;
    this.requireStatus(config, status);
    if (!config.priorities.includes(priority)) {
      throw new BoardStoreError(
        "invalid-priority",
        `invalid priority "${priority}"`,
      );
    }
    if (statusRequiresClaim(config, status)) {
      throw new BoardStoreError(
        "claim-required",
        `status "${status}" requires a claim`,
      );
    }
    await this.requireReferencesExist(config, parameters);

    return this.allocateAndWrite(config, parameters, priority, status);
  }

  private async config(): Promise<BoardConfig> {
    return readBoardConfig(this.boardDirectory);
  }

  private tasks(config: BoardConfig): string {
    return tasksPath(this.boardDirectory, config);
  }

  private requireStatus(config: BoardConfig, status: string): void {
    if (!statusNames(config).includes(status)) {
      throw new BoardStoreError("invalid-status", `invalid status "${status}"`);
    }
  }

  /**
   * Heddle mutates the board without holding a claim, so any live claim by an
   * operator or another agent makes the task off-limits — the same refusal the
   * CLI gives an unclaimed caller. An expired claim is no longer a claim.
   */
  private requireUnclaimed(config: BoardConfig, task: StoredTask): void {
    if (task.claimedBy === "") return;
    const timeout = config.claimTimeoutMilliseconds;
    if (
      timeout > 0 &&
      task.claimedAt !== undefined &&
      Date.now() - task.claimedAt.getTime() > timeout
    ) {
      task.document.frontMatter.delete("claimed_by");
      task.document.frontMatter.delete("claimed_at");
      task.claimedBy = "";
      delete task.claimedAt;
      return;
    }
    throw new BoardStoreError(
      "task-claimed",
      `task #${task.id} is claimed by "${task.claimedBy}"`,
    );
  }

  private async requireWipHeadroom(
    config: BoardConfig,
    task: StoredTask,
    targetStatus: string,
  ): Promise<void> {
    const taskClass = task.class;
    const classLimit =
      taskClass === "" ? undefined : config.classWipLimits.get(taskClass);
    const everyTask = await readAllTasksLenient(this.tasks(config));

    if (classLimit !== undefined && classLimit.wipLimit > 0) {
      const count = everyTask.filter(
        (candidate) => candidate.class === taskClass && candidate.id !== task.id,
      ).length;
      if (count >= classLimit.wipLimit) {
        throw new BoardStoreError(
          "wip-limit-exceeded",
          `${taskClass} WIP limit reached (${count}/${classLimit.wipLimit} board-wide)`,
        );
      }
    }
    if (classLimit?.bypassColumnWip === true) return;

    const limit = config.wipLimits.get(targetStatus) ?? 0;
    if (limit === 0 || task.status === targetStatus) return;
    const count = everyTask.filter(
      ({ status }) => status === targetStatus,
    ).length;
    if (count >= limit) {
      throw new BoardStoreError(
        "wip-limit-exceeded",
        `WIP limit reached for "${targetStatus}" (${count}/${limit})`,
      );
    }
  }

  private async requireReferencesExist(
    config: BoardConfig,
    parameters: CreateTaskParameters,
  ): Promise<void> {
    const references = [
      ...(parameters.parent === undefined ? [] : [parameters.parent]),
      ...(parameters.dependsOn ?? []),
    ];
    for (const reference of references) {
      try {
        await findTaskFileById(this.tasks(config), reference);
      } catch {
        throw new BoardStoreError(
          "dependency-not-found",
          `dependency task #${reference} not found`,
        );
      }
    }
  }

  /**
   * Allocates the next id, writes the task, then confirms no other file claims
   * that id. The CLI takes an exclusive lock for this section; Heddle cannot
   * join that lock from Node, so it instead yields to any file the CLI landed
   * on the same id and retries with a higher one.
   */
  private async allocateAndWrite(
    config: BoardConfig,
    parameters: CreateTaskParameters,
    priority: string,
    status: string,
  ): Promise<StoredTask> {
    const directory = this.tasks(config);
    const slug = generateSlug(parameters.title);

    for (let attempt = 0; attempt < ID_ALLOCATION_ATTEMPTS; attempt += 1) {
      const current = await readBoardConfig(this.boardDirectory);
      const existing = await readAllTasksLenient(directory);
      const highest = existing.reduce((left, { id }) => Math.max(left, id), 0);
      const id = Math.max(current.nextId, highest + 1) + attempt;
      const path = join(directory, generateFilename(id, slug));

      if (existing.some((candidate) => candidate.file === path)) continue;

      const now = new Date();
      const document = this.composeTask(
        current,
        parameters,
        { id, priority, status },
        now,
      );
      await writeFileAtomic(path, renderTaskFile(document));

      const owners = (await readAllTasksLenient(directory)).filter(
        (candidate) => candidate.id === id,
      );
      if (owners.length !== 1 || owners[0]!.file !== path) {
        await unlink(path).catch(() => undefined);
        continue;
      }

      await persistNextId(this.boardDirectory, Math.max(current.nextId, id + 1));
      return readTaskFile(path);
    }

    throw new BoardStoreError(
      "id-allocation-failed",
      "could not allocate a free task id",
    );
  }

  private composeTask(
    config: BoardConfig,
    parameters: CreateTaskParameters,
    identity: { id: number; priority: string; status: string },
    now: Date,
  ): { body: string; frontMatter: Document } {
    const fields = new Map<string, unknown>([
      ["id", identity.id],
      ["title", parameters.title],
      ["status", identity.status],
      ["priority", identity.priority],
      ["created", timestamp(now)],
      ["updated", timestamp(now)],
    ]);
    if (parameters.tags !== undefined && parameters.tags.length > 0) {
      fields.set("tags", parameters.tags);
    }
    if (parameters.parent !== undefined) fields.set("parent", parameters.parent);
    if (parameters.dependsOn !== undefined && parameters.dependsOn.length > 0) {
      fields.set("depends_on", parameters.dependsOn);
    }
    if (config.defaultClass !== "") fields.set("class", config.defaultClass);

    const frontMatter = new Document({});
    for (const key of CANONICAL_KEY_ORDER) {
      if (fields.has(key)) frontMatter.set(key, fields.get(key));
    }
    // Properties Heddle owns but kanban-md does not are ordinary frontmatter,
    // written after the canonical keys and preserved by the CLI on write.
    for (const [key, value] of Object.entries(parameters.properties ?? {})) {
      frontMatter.set(key, value);
    }

    return { body: parameters.body ?? "", frontMatter };
  }

}
