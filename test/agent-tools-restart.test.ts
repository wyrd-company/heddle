// ---
// relationships:
//   verifies: agent-tools
// ---
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ToolBinding } from "../src/agent-tools/index.js";
it("SIGKILL and restart regenerates every paused instance at the same paths with the same credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "heddle-restart-"));
  let child: ChildProcess | undefined;
  const start = async (port = 0) => {
    child = fork(
      join(process.cwd(), "scripts/agent-tools-process-fixture.mjs"),
      [join(directory, "runs.sqlite"), String(port)],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    const [ready] = (await once(child, "message")) as unknown[];
    return ready as { port: number; bindings: ToolBinding[] };
  };
  try {
    const initial = await start();
    expect(initial.bindings).toHaveLength(2);
    const list = async (binding: ToolBinding) => {
      const response = await fetch(
        `http://127.0.0.1:${String(initial.port)}` + binding.path,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${binding.token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        },
      );
      expect(response.status).toBe(200);
      return response.json();
    };
    const before = await Promise.all(initial.bindings.map(list));
    required(child).kill("SIGKILL");
    await once(required(child), "exit");
    const recovered = await start(initial.port);
    expect(recovered.bindings).toEqual([]);
    expect(await Promise.all(initial.bindings.map(list))).toEqual(before);
  } finally {
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
