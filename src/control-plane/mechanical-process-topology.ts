// ---
// relationships:
//   verifies: heddle
// ---

import { execFile, type ChildProcess } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { expect } from "vitest";

import type { LifecycleFixture } from "./mechanical-process-termination-fixture.js";

const execute = promisify(execFile);

export interface ProcessRecord {
  arguments: string;
  command: string;
  parentPid: number;
  processGroupId: number;
  processId: number;
}

export const readProcessGroup = async (
  processGroupId: number,
): Promise<ProcessRecord[]> => {
  const output = (await execute("ps", ["-eo", "pid=,ppid=,pgid=,comm=,args="]))
    .stdout;
  return output
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      arguments: match[5] ?? "",
      command: match[4] ?? "",
      parentPid: Number(match[2]),
      processGroupId: Number(match[3]),
      processId: Number(match[1]),
    }))
    .filter((record) => record.processGroupId === processGroupId);
};

export const waitForEmptyProcessGroup = async (
  processGroupId: number,
): Promise<ProcessRecord[]> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const remaining = await readProcessGroup(processGroupId);
    if (remaining.length === 0) return remaining;
    await delay(20);
  }
  return readProcessGroup(processGroupId);
};

export const waitForSettledProcessGroup = async (
  processGroupId: number,
  holdsLease: boolean,
): Promise<ProcessRecord[]> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const observed = await readProcessGroup(processGroupId);
    const gitProcesses = observed.filter(({ command }) => command === "git");
    if (gitProcesses.length === (holdsLease ? 1 : 0)) return observed;
    await delay(20);
  }
  return readProcessGroup(processGroupId);
};

const lockFilesBelow = async (root: string): Promise<string[]> => {
  const locks: string[] = [];
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.name.endsWith(".lock")) locks.push(child);
    }
  };
  await visit(root);
  return locks.sort();
};

export const readRepositoryRefLocks = (
  fixture: LifecycleFixture,
): Promise<string[]> => lockFilesBelow(join(fixture.repositoryRoot, ".git"));

const signalProcessGroup = async (processGroupId: number): Promise<void> => {
  if ((await readProcessGroup(processGroupId)).length === 0) return;
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch (error) {
    if ((error as { code?: string }).code !== "ESRCH") throw error;
  }
};

export const settleRestartProcessGroup = async (
  child: ChildProcess,
  fixture: LifecycleFixture,
  failed: boolean,
): Promise<void> => {
  const processGroupId = child.pid!;
  if (failed && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  let remaining = await waitForEmptyProcessGroup(processGroupId);
  if (failed && remaining.length > 0) {
    await signalProcessGroup(processGroupId);
    remaining = await waitForEmptyProcessGroup(processGroupId);
  }
  expect(
    remaining,
    `orphaned restart process group:\n${JSON.stringify(remaining, null, 2)}`,
  ).toEqual([]);
  expect(await readRepositoryRefLocks(fixture)).toEqual([]);
};
