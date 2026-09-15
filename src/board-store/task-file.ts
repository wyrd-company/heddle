// ---
// relationships:
//   implements: heddle
// ---

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { isMap, isSeq, type Document } from "yaml";

import { writeFileAtomic } from "./atomic-write.js";
import { BoardStoreError } from "./errors.js";
import {
  parseTaskFile,
  renderTaskFile,
  type TaskDocument,
} from "./front-matter.js";

const MAX_SLUG_LENGTH = 50;
const MINIMUM_ID_WIDTH = 3;
const TASK_FILE_EXTENSION = ".md";

/** A task file as it exists on disk, with its document retained for writing. */
export interface StoredTask {
  blocked: boolean;
  claimedAt?: Date;
  claimedBy: string;
  class: string;
  dependsOn: number[];
  document: TaskDocument;
  file: string;
  id: number;
  parent?: number;
  priority: string;
  status: string;
  tags: string[];
  title: string;
}

export const generateSlug = (title: string): string => {
  let slug = title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");
  slug = slug.replaceAll(/^-+|-+$/g, "");
  if (slug.length > MAX_SLUG_LENGTH) {
    let truncated = slug.slice(0, MAX_SLUG_LENGTH);
    // Only trim back to a word boundary when the cut landed mid-word.
    if (slug[MAX_SLUG_LENGTH] !== "-") {
      const lastHyphen = truncated.lastIndexOf("-");
      if (lastHyphen > 0) truncated = truncated.slice(0, lastHyphen);
    }
    slug = truncated.replaceAll(/-+$/g, "");
  }
  return slug;
};

export const generateFilename = (id: number, slug: string): string => {
  const identifier = String(id);
  const width = Math.max(MINIMUM_ID_WIDTH, identifier.length);
  return `${identifier.padStart(width, "0")}-${slug}${TASK_FILE_EXTENSION}`;
};

const scalar = (frontMatter: Document, key: string): unknown =>
  isMap(frontMatter.contents) ? frontMatter.get(key, false) : undefined;

const requiredString = (
  frontMatter: Document,
  key: string,
  path: string,
): string => {
  const value = frontMatter.get(key) as unknown;
  if (typeof value !== "string" || value.trim() === "") {
    throw new BoardStoreError(
      "invalid-task",
      `missing required field: ${key} in ${path}`,
    );
  }
  return value;
};

const optionalString = (frontMatter: Document, key: string): string => {
  const value = frontMatter.get(key) as unknown;
  return typeof value === "string" ? value : "";
};

const numberList = (frontMatter: Document, key: string): number[] => {
  const node = frontMatter.get(key, true);
  if (!isSeq(node)) return [];
  return (node.toJSON() as unknown[]).filter(
    (item): item is number => typeof item === "number",
  );
};

const stringList = (frontMatter: Document, key: string): string[] => {
  const node = frontMatter.get(key, true);
  if (!isSeq(node)) return [];
  return (node.toJSON() as unknown[]).filter(
    (item): item is string => typeof item === "string",
  );
};

const optionalDate = (frontMatter: Document, key: string): Date | undefined => {
  const value = frontMatter.get(key) as unknown;
  if (value instanceof Date) return value;
  if (typeof value !== "string" || value === "") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

export const interpretTaskFile = (source: string, path: string): StoredTask => {
  const document = parseTaskFile(source);
  const { frontMatter } = document;

  const id = frontMatter.get("id") as unknown;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
    throw new BoardStoreError(
      "invalid-task",
      `missing required field: id in ${path}`,
    );
  }

  const parent = frontMatter.get("parent") as unknown;

  return {
    blocked: scalar(frontMatter, "blocked") === true,
    ...(optionalDate(frontMatter, "claimed_at") === undefined
      ? {}
      : { claimedAt: optionalDate(frontMatter, "claimed_at")! }),
    claimedBy: optionalString(frontMatter, "claimed_by"),
    class: optionalString(frontMatter, "class"),
    dependsOn: numberList(frontMatter, "depends_on"),
    document,
    file: path,
    id,
    ...(typeof parent === "number" ? { parent } : {}),
    priority: requiredString(frontMatter, "priority", path),
    status: requiredString(frontMatter, "status", path),
    tags: stringList(frontMatter, "tags"),
    title: requiredString(frontMatter, "title", path),
  };
};

export const readTaskFile = async (path: string): Promise<StoredTask> =>
  interpretTaskFile(await readFile(path, "utf8"), path);

export const writeTaskFile = async (task: StoredTask): Promise<void> => {
  await writeFileAtomic(task.file, renderTaskFile(task.document));
};

const isTaskFile = (name: string): boolean =>
  name.endsWith(TASK_FILE_EXTENSION);

export const listTaskFilenames = async (
  tasksDirectory: string,
): Promise<string[]> => {
  let entries;
  try {
    entries = await readdir(tasksDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => !entry.isDirectory() && isTaskFile(entry.name))
    .map((entry) => entry.name)
    .sort();
};

/**
 * Reads every task file, skipping malformed ones. kanban-md's own listing is
 * lenient in the same way, so a hand-broken file does not hide the board.
 */
export const readAllTasksLenient = async (
  tasksDirectory: string,
): Promise<StoredTask[]> => {
  const names = await listTaskFilenames(tasksDirectory);
  const tasks: StoredTask[] = [];
  for (const name of names) {
    const path = join(tasksDirectory, name);
    try {
      tasks.push(await readTaskFile(path));
    } catch {
      continue;
    }
  }
  return tasks;
};

/**
 * Resolves a task id to its file. The filename prefix is the fast path and the
 * frontmatter id is authoritative, matching how kanban-md resolves an id.
 */
export const findTaskFileById = async (
  tasksDirectory: string,
  id: number,
): Promise<string> => {
  const names = await listTaskFilenames(tasksDirectory);
  const identifier = String(id);
  let prefixFallback = "";

  for (const name of names) {
    const dash = name.indexOf("-");
    if (dash < 1) continue;
    if (name.slice(0, dash).replace(/^0+/, "") !== identifier) continue;
    const path = join(tasksDirectory, name);
    try {
      if ((await readTaskFile(path)).id === id) return path;
    } catch {
      if (prefixFallback === "") prefixFallback = path;
    }
  }

  for (const name of names) {
    const path = join(tasksDirectory, name);
    try {
      if ((await readTaskFile(path)).id === id) return path;
    } catch {
      continue;
    }
  }

  if (prefixFallback !== "") return prefixFallback;
  throw new BoardStoreError("task-not-found", `task not found: #${id}`);
};
