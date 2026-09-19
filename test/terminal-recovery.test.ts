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

async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}
function message(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let errors = "";
    child.stderr?.on("data", (data: unknown) => {
      errors += String(data);
    });
    const failed = () => {
      reject(new Error(`Fixture exited: ${errors}`));
    };
    child.once("exit", failed);
    child.once("error", reject);
    child.once("message", (value) => {
      child.off("exit", failed);
      resolve(value);
    });
  });
}
it("retains terminal child data across SIGKILL between branch completions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "heddle-terminal-recovery-"));
  const children: ChildProcess[] = [];
  const launch = (mode: string) => {
    const child = fork(
      fileURLToPath(new URL("./terminal-recovery.fixture.ts", import.meta.url)),
      [join(directory, "runs.sqlite"), mode],
      { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    children.push(child);
    return child;
  };
  try {
    const first = launch("crash");
    expect(await message(first)).toEqual({
      status: "awaiting",
      first: { amount: 7 },
      combined: null,
    });
    await kill(first);
    expect(first.signalCode).toBe("SIGKILL");
    const restarted = launch("restart");
    const exited = once(restarted, "exit");
    expect(await message(restarted)).toEqual({
      before: "awaiting",
      status: "completed",
      result: { dimensions: { width: 3 }, mass: { amount: 7 } },
      keys: ["dimensions", "mass"],
    });
    await exited;
    expect(restarted.exitCode).toBe(0);
  } finally {
    for (const child of children) await kill(child);
    rmSync(directory, { recursive: true, force: true });
  }
});
