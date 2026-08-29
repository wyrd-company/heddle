// ---
// relationships:
//   verifies: heddle
// ---

import { spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";

import { expect } from "vitest";

import type {
  LifecycleSnapshot,
  ResumeLifecycleInput,
} from "../engine/index.js";
import {
  readProcessGroup,
  readRepositoryRefLocks,
  settleRestartProcessGroup,
  waitForEmptyProcessGroup,
  waitForSettledProcessGroup,
  type ProcessRecord,
} from "./mechanical-process-topology.js";
import type { LifecycleFixture } from "./mechanical-process-termination-fixture.js";
import type { MechanicalTerminationBoundary } from "./mechanical-process-termination-worker.js";

const workerCwd = process.cwd();
const workerPath = fileURLToPath(
  new URL("./mechanical-process-termination-worker.ts", import.meta.url),
);

export interface BoundaryRecord {
  arguments: string[];
  boundary: MechanicalTerminationBoundary;
  executable: string;
  input?: string;
  kind: "boundary";
  phase: "after" | "before";
  pid: number;
}

interface ResultRecord {
  kind: "result";
  result: LifecycleSnapshot;
}

export interface ErrorRecord {
  kind: "error";
  message: string;
  name: string;
}

type WorkerRecord = BoundaryRecord | ErrorRecord | ResultRecord;

interface WorkerConfiguration {
  boundary?: MechanicalTerminationBoundary;
  change: LifecycleFixture["change"];
  repositoryRoot: string;
  resume: ResumeLifecycleInput;
  stateDirectory: string;
}

interface RunningWorker {
  child: ChildProcess;
  exit: Promise<{ code: number | null; signal: string | null }>;
  stderr: () => string;
  waitForRecord: <T extends WorkerRecord["kind"]>(
    kind: T,
  ) => Promise<Extract<WorkerRecord, { kind: T }>>;
}

export interface RestartProbe {
  boundary: MechanicalTerminationBoundary;
  onLaunch?: (processGroupId: number) => void;
  timeoutMilliseconds: number;
}

const withTimeout = async <T>(
  promise: Promise<T>,
  message: string,
  timeoutMilliseconds = 15_000,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(message)),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const launchWorker = async (
  fixture: LifecycleFixture,
  resume: ResumeLifecycleInput,
  boundary?: MechanicalTerminationBoundary,
  timeoutMilliseconds = 15_000,
): Promise<RunningWorker> => {
  const configuration: WorkerConfiguration = {
    boundary,
    change: fixture.change,
    repositoryRoot: fixture.repositoryRoot,
    resume,
    stateDirectory: fixture.stateDirectory,
  };
  const configurationPath = join(
    dirname(fixture.repositoryRoot),
    `worker-${boundary ?? "restart"}.json`,
  );
  await writeFile(configurationPath, JSON.stringify(configuration));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", workerPath, configurationPath],
    {
      cwd: workerCwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (
    child.pid === undefined ||
    child.stdout === null ||
    child.stderr === null
  ) {
    throw new Error("Could not start the process-termination worker");
  }
  const records: WorkerRecord[] = [];
  const waiters = new Set<() => void>();
  let standardError = "";
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() !== "") records.push(JSON.parse(line) as WorkerRecord);
    }
    for (const notify of waiters) notify();
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    standardError += chunk;
  });
  const exit = new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );

  return {
    child,
    exit,
    stderr: () => standardError,
    waitForRecord: async <T extends WorkerRecord["kind"]>(kind: T) =>
      withTimeout(
        Promise.race([
          new Promise<Extract<WorkerRecord, { kind: T }>>((resolve, reject) => {
            const inspect = (): void => {
              const record = records.find(
                (candidate): candidate is Extract<WorkerRecord, { kind: T }> =>
                  candidate.kind === kind,
              );
              if (record !== undefined) {
                waiters.delete(inspect);
                resolve(record);
                return;
              }
              const error = records.find(
                (candidate): candidate is ErrorRecord =>
                  candidate.kind === "error",
              );
              if (error !== undefined && kind !== "error") {
                waiters.delete(inspect);
                reject(new Error(`${error.name}: ${error.message}`));
              }
            };
            waiters.add(inspect);
            inspect();
          }),
          exit.then(({ code, signal }) => {
            throw new Error(
              `Worker exited before ${kind}: code=${code}, signal=${signal}; stderr: ${standardError}`,
            );
          }),
        ]),
        `Worker did not emit ${kind}`,
        timeoutMilliseconds,
      ),
  };
};

export const terminateAtBoundary = async (
  fixture: LifecycleFixture,
  resume: ResumeLifecycleInput,
  boundary: MechanicalTerminationBoundary,
): Promise<{
  locksBeforeKill: string[];
  marker: BoundaryRecord;
  topologyBeforeKill: ProcessRecord[];
}> => {
  const worker = await launchWorker(fixture, resume, boundary);
  const processGroupId = worker.child.pid!;
  try {
    const marker = await worker.waitForRecord("boundary");
    const holdsLease =
      boundary === "exact-base-leased" || boundary === "approval-recorded";
    const topologyBeforeKill = await waitForSettledProcessGroup(
      processGroupId,
      holdsLease,
    );
    const locksBeforeKill = await readRepositoryRefLocks(fixture);
    expect(worker.child.kill("SIGKILL")).toBe(true);
    await expect(worker.exit).resolves.toEqual({
      code: null,
      signal: "SIGKILL",
    });
    const remaining = await waitForEmptyProcessGroup(processGroupId);
    expect(
      remaining,
      `orphaned process group:\n${JSON.stringify(remaining, null, 2)}`,
    ).toEqual([]);
    expect(await readRepositoryRefLocks(fixture)).toEqual([]);
    return { locksBeforeKill, marker, topologyBeforeKill };
  } finally {
    const remaining = await readProcessGroup(processGroupId);
    if (remaining.length > 0) process.kill(-processGroupId, "SIGKILL");
  }
};

export const restartOperation = async (
  fixture: LifecycleFixture,
  resume: ResumeLifecycleInput,
  probe?: RestartProbe,
): Promise<LifecycleSnapshot> => {
  const worker = await launchWorker(
    fixture,
    resume,
    probe?.boundary,
    probe?.timeoutMilliseconds,
  );
  probe?.onLaunch?.(worker.child.pid!);
  let completed = false;
  try {
    const result = await worker.waitForRecord("result");
    const exited = await withTimeout(
      worker.exit,
      "Restart worker did not exit",
      probe?.timeoutMilliseconds,
    );
    expect(exited, worker.stderr()).toEqual({ code: 0, signal: null });
    completed = true;
    return result.result;
  } finally {
    await settleRestartProcessGroup(worker.child, fixture, !completed);
  }
};

export const restartExpectingAttention = async (
  fixture: LifecycleFixture,
  resume: ResumeLifecycleInput,
): Promise<ErrorRecord> => {
  const worker = await launchWorker(fixture, resume);
  let completed = false;
  try {
    const error = await worker.waitForRecord("error");
    const exited = await withTimeout(
      worker.exit,
      "Restart worker did not exit",
    );
    expect(exited).toEqual({ code: 1, signal: null });
    completed = true;
    return error;
  } finally {
    await settleRestartProcessGroup(worker.child, fixture, !completed);
  }
};
