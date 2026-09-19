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
import { expect, it, onTestFinished } from "vitest";
import { issue } from "./lifecycle-snapshot.fixture.js";

async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, "exit");
  child.kill("SIGKILL");
  await exit;
}
function observe(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let errors = "";
    child.stderr?.on("data", (value) => {
      errors += String(value);
    });
    const exited = () => {
      reject(new Error(`Fixture exited before observation: ${errors}`));
    };
    child.once("exit", exited);
    child.once("error", reject);
    child.once("message", (value) => {
      child.off("exit", exited);
      resolve(value);
    });
  });
}
it.each(["after-create", "after-intake", "after-lifecycle-pause"])(
  "recovers lifecycle origin and immutable inputs before instance attachment after death %s",
  async (boundary) => {
    const directory = mkdtempSync(join(tmpdir(), "heddle-lifecycle-"));
    const path = join(directory, "runs.sqlite");
    const children: ChildProcess[] = [];
    const cleanup = async () => {
      for (const child of children) await kill(child);
      rmSync(directory, { recursive: true, force: true });
    };
    onTestFinished(cleanup);
    function launch(mode: string) {
      const child = fork(
        fileURLToPath(
          new URL("./lifecycle-recovery.fixture.ts", import.meta.url),
        ),
        [path, boundary, mode],
        {
          execArgv: [],
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      children.push(child);
      return child;
    }
    const id = JSON.stringify(["intake-1", "start", 1]);
    const links = [
      { runId: "intake-1", nodeId: "start", visit: 1, lifecycleRunId: id },
    ];
    const initialContext = {
      issue,
      settings: { category: "rare" },
    };
    try {
      const first = launch("crash");
      expect(await observe(first)).toEqual({ boundary, links });
      await kill(first);
      expect(first.signalCode).toBe("SIGKILL");
      const restarted = launch("restart");
      const exit = once(restarted, "exit");
      expect(await observe(restarted)).toEqual({
        links,
        count: 2,
        attachment: {
          before: null,
          after: id,
          currentTitle: "Changed after lifecycle creation",
        },
        before: { status: "awaiting", initialContext },
        lifecycle: {
          id,
          rootId: id,
          parentId: null,
          commit: "commit-a",
          status: "completed",
          initialContext,
          effect: initialContext,
        },
        intake: {
          status: "completed",
          output: { started: true, payload: { runId: id } },
          starts: 1,
        },
        effectCount: 1,
        unchanged: true,
      });
      expect((await exit)[0]).toBe(0);
    } finally {
      await cleanup();
    }
  },
);
