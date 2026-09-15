// ---
// relationships:
//   implements: heddle
// ---

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseDocument, type Document } from "yaml";

import { BoardStoreError } from "./errors.js";
import { writeFileAtomic } from "./atomic-write.js";

/** The reserved status name kanban-md gives soft-deleted tasks. */
export const ARCHIVED_STATUS = "archived";

const CONFIG_FILE_NAME = "config.yml";

export interface BoardStatus {
  name: string;
  requireClaim: boolean;
}

export interface BoardConfig {
  claimTimeoutMilliseconds: number;
  classNames: string[];
  classWipLimits: Map<string, { bypassColumnWip: boolean; wipLimit: number }>;
  defaultClass: string;
  defaultPriority: string;
  defaultStatus: string;
  nextId: number;
  priorities: string[];
  statuses: BoardStatus[];
  tasksDirectory: string;
  wipLimits: Map<string, number>;
}

const configPath = (boardDirectory: string): string =>
  join(boardDirectory, CONFIG_FILE_NAME);

const invalid = (detail: string): never => {
  throw new BoardStoreError("invalid-config", `board config ${detail}`);
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asStringList = (value: unknown, field: string): string[] => {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    return invalid(`${field} must be a list of strings`);
  }
  return value;
};

/**
 * Parses a Go `time.ParseDuration` string. kanban-md accepts the units Go
 * accepts; Heddle only needs the ones a board can express as a claim timeout.
 */
const parseGoDuration = (value: string): number | undefined => {
  const pattern = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
  const scales: Record<string, number> = {
    h: 3_600_000,
    m: 60_000,
    ms: 1,
    ns: 1e-6,
    s: 1000,
    us: 0.001,
    µs: 0.001,
  };
  let total = 0;
  let consumed = 0;
  for (const match of value.matchAll(pattern)) {
    total += Number(match[1]) * scales[match[2]!]!;
    consumed += match[0].length;
  }
  if (consumed !== value.length || consumed === 0) return undefined;
  return total;
};

/**
 * A status entry is either a plain name or a mapping. kanban-md accepts both
 * for backward compatibility, so Heddle reads both.
 */
const readStatus = (entry: unknown): BoardStatus => {
  if (typeof entry === "string") return { name: entry, requireClaim: false };
  const mapping = asRecord(entry);
  const name = mapping["name"];
  if (typeof name !== "string" || name === "") {
    return invalid("statuses entries need a name");
  }
  return { name, requireClaim: mapping["require_claim"] === true };
};

export const readBoardConfig = async (
  boardDirectory: string,
): Promise<BoardConfig> => {
  let source: string;
  try {
    source = await readFile(configPath(boardDirectory), "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      throw new BoardStoreError(
        "board-not-found",
        `no kanban board found at ${boardDirectory}`,
      );
    }
    throw error;
  }
  return interpretBoardConfig(source);
};

export const interpretBoardConfig = (source: string): BoardConfig => {
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    return invalid(`is not valid YAML: ${document.errors[0]!.message}`);
  }
  const root = asRecord(document.toJS() as unknown);

  const statuses = Array.isArray(root["statuses"])
    ? root["statuses"].map(readStatus)
    : invalid("statuses must be a list");
  if (statuses.length < 2) return invalid("needs at least 2 statuses");

  const priorities = asStringList(root["priorities"], "priorities");
  if (priorities.length < 1) return invalid("needs at least 1 priority");

  const defaults = asRecord(root["defaults"]);
  const tasksDirectory = root["tasks_dir"];
  if (typeof tasksDirectory !== "string" || tasksDirectory === "") {
    return invalid("tasks_dir is required");
  }

  const nextId = root["next_id"];
  if (typeof nextId !== "number" || !Number.isInteger(nextId) || nextId < 1) {
    return invalid("next_id must be an integer >= 1");
  }

  const claimTimeout = root["claim_timeout"];
  const claimTimeoutMilliseconds =
    typeof claimTimeout === "string" && claimTimeout !== ""
      ? (parseGoDuration(claimTimeout) ?? 0)
      : 0;

  const classEntries = Array.isArray(root["classes"]) ? root["classes"] : [];
  const classWipLimits = new Map<
    string,
    { bypassColumnWip: boolean; wipLimit: number }
  >();
  const classNames: string[] = [];
  for (const entry of classEntries) {
    const mapping = asRecord(entry);
    const name = mapping["name"];
    if (typeof name !== "string" || name === "") {
      return invalid("classes entries need a name");
    }
    classNames.push(name);
    classWipLimits.set(name, {
      bypassColumnWip: mapping["bypass_column_wip"] === true,
      wipLimit:
        typeof mapping["wip_limit"] === "number" ? mapping["wip_limit"] : 0,
    });
  }

  const wipLimits = new Map<string, number>();
  for (const [status, limit] of Object.entries(asRecord(root["wip_limits"]))) {
    if (typeof limit === "number") wipLimits.set(status, limit);
  }

  return {
    claimTimeoutMilliseconds,
    classNames,
    classWipLimits,
    defaultClass:
      typeof defaults["class"] === "string" ? defaults["class"] : "",
    defaultPriority:
      typeof defaults["priority"] === "string" ? defaults["priority"] : "",
    defaultStatus:
      typeof defaults["status"] === "string" ? defaults["status"] : "",
    nextId,
    priorities,
    statuses,
    tasksDirectory,
    wipLimits,
  };
};

export const tasksPath = (
  boardDirectory: string,
  config: BoardConfig,
): string => join(boardDirectory, config.tasksDirectory);

export const statusNames = (config: BoardConfig): string[] =>
  config.statuses.map(({ name }) => name);

/** Board columns exclude the archived status, matching `kanban-md board`. */
export const boardStatusNames = (config: BoardConfig): string[] =>
  statusNames(config).filter((name) => name !== ARCHIVED_STATUS);

export const statusRequiresClaim = (
  config: BoardConfig,
  status: string,
): boolean =>
  config.statuses.find(({ name }) => name === status)?.requireClaim === true;

/**
 * Both the `archived` status and the column immediately before it are terminal.
 * A board without an archived column treats its last status as terminal.
 */
export const isTerminalStatus = (
  config: BoardConfig,
  status: string,
): boolean => {
  const names = statusNames(config);
  if (names.length === 0) return false;
  if (status === ARCHIVED_STATUS) return true;
  const last = names.length - 1;
  if (names[last] === ARCHIVED_STATUS && last > 0) {
    return status === names[last - 1];
  }
  return status === names[last];
};

/**
 * Rewrites `next_id` in place, leaving every other byte of the config document
 * as the operator (or the CLI) wrote it.
 */
export const persistNextId = async (
  boardDirectory: string,
  nextId: number,
): Promise<void> => {
  const path = configPath(boardDirectory);
  const document: Document = parseDocument(await readFile(path, "utf8"));
  document.set("next_id", nextId);
  await writeFileAtomic(path, document.toString({ indent: 4 }));
};
