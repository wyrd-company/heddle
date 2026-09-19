// ---
// relationships:
//   verifies: engine-and-run-model
// ---
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

function launch(
  path: string,
  mode: string,
  fixture = "engine-process",
): ChildProcess {
  return fork(
    fileURLToPath(new URL(`./${fixture}.fixture.ts`, import.meta.url)),
    [path, mode],
    {
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
}
async function nextMessage(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onExit = (code: number | null) => {
      reject(new Error(`Fixture exited before signal: ${String(code)}`));
    };
    child.once("exit", onExit);
    child.once("error", reject);
    child.once("message", (message) => {
      child.off("exit", onExit);
      resolve(message);
    });
  });
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}
it.each(["paused", "mid-node", "resuming"])(
  "recovers after process death while %s with stable effect identity",
  async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "heddle-recovery-"));
    const path = join(directory, "runs.sqlite");
    const children: ChildProcess[] = [];
    try {
      const child = launch(path, mode);
      children.push(child);
      let errors = "";
      child.stderr?.on("data", (chunk) => {
        errors += String(chunk);
      });
      expect(await nextMessage(child), errors).toBe(mode);
      await stop(child);
      expect(child.signalCode).toBe("SIGKILL");
      const restarted = launch(path, "resume");
      children.push(restarted);
      const completed = once(restarted, "exit");
      expect(await nextMessage(restarted)).toEqual({
        status: "completed",
        effects: [
          {
            id: JSON.stringify(["delivery-1", "record", 1]),
            attempts: 1,
          },
          {
            id: JSON.stringify(["delivery-1", "prepare", 1]),
            attempts: mode === "mid-node" ? 2 : 1,
          },
          {
            id: JSON.stringify(["delivery-1", "finish", 1]),
            attempts: mode === "resuming" ? 2 : 1,
          },
        ],
      });
      expect((await completed)[0]).toBe(0);
    } finally {
      for (const child of children) await stop(child);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("discards stale idle across process deaths after queue, activity, and drain", async () => {
  const directory = mkdtempSync(join(tmpdir(), "heddle-idle-recovery-"));
  const path = join(directory, "runs.sqlite");
  const children: ChildProcess[] = [];
  async function stage(mode: string) {
    const child = launch(path, mode, "engine-idle");
    children.push(child);
    const state = await nextMessage(child);
    await stop(child);
    expect(child.signalCode).toBe("SIGKILL");
    return state;
  }
  try {
    const queued = await stage("queue");
    expect(queued).toMatchObject({
      status: "running",
      awaiting: ["second"],
      wakeups: [{ id: 1, due: 100 }],
      queued: [{ result: "idle", wakeupId: 1, payload: { due: 100 } }],
      idle: [],
      late: [],
    });
    expect(await stage("activity")).toEqual({
      ...(queued as object),
      wakeups: [{ id: 1, due: 250 }],
    });
    const drained = await stage("drain");
    expect(drained).toMatchObject({
      status: "awaiting",
      awaiting: ["second"],
      wakeups: [{ id: 1, due: 250 }],
      queued: [],
      idle: [],
      late: [{ payload: { result: "idle", payload: { due: 100 } } }],
    });
    const restarted = launch(path, "deliver", "engine-idle");
    children.push(restarted);
    const completed = once(restarted, "exit");
    expect(await nextMessage(restarted)).toEqual({
      beforeDue: drained,
      afterDue: {
        status: "completed",
        awaiting: [],
        wakeups: [],
        queued: [],
        idle: [
          {
            sequence: expect.any(Number) as unknown,
            type: "resume",
            payload: {
              id: 1,
              runId: "collection-1",
              nodeId: "second",
              visit: 1,
              result: "idle",
              due: 250,
              wakeupId: 1,
              payload: { due: 250 },
            },
          },
        ],
        late: (drained as { late: unknown }).late,
      },
    });
    expect((await completed)[0]).toBe(0);
  } finally {
    for (const child of children) await stop(child);
    rmSync(directory, { recursive: true, force: true });
  }
});
