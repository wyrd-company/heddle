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

function launch(path: string, mode: string): ChildProcess {
  return fork(
    fileURLToPath(new URL("./engine-process.fixture.ts", import.meta.url)),
    [path, mode],
    {
      execArgv: ["--experimental-transform-types"],
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
it.each(["paused", "mid-node"])(
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
      const restarted = launch(path, "resume");
      children.push(restarted);
      const completed = once(restarted, "exit");
      expect(await nextMessage(restarted)).toEqual({
        status: "completed",
        effects: [
          {
            id: JSON.stringify(["delivery-1", "record", 1]),
            attempts: mode === "mid-node" ? 2 : 1,
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
