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
import { RunStore, WorkflowEngine, type ResumeInput } from "../src/index.js";
function launch(file: string, args: string[] = []) {
  return fork(fileURLToPath(new URL(file, import.meta.url)), args, {
    execArgv: ["--experimental-transform-types"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
}
async function message(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let errors = "";
    child.stderr?.on("data", (data) => {
      errors += String(data);
    });
    const onExit = () => {
      reject(new Error(`Fixture exited: ${errors}`));
    };
    child.once("exit", onExit);
    child.once("error", reject);
    child.once("message", (value) => {
      child.off("exit", onExit);
      resolve(value);
    });
  });
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}
it.each([
  "fanout",
  "after-claim",
  "after-node",
  "after-pause",
  "before-child",
  "after-child",
  "paused-after-child",
])(
  "recovers the durable %s boundary after a real process kill",
  async (boundary) => {
    const directory = mkdtempSync(join(tmpdir(), "heddle-boundary-"));
    const path = join(directory, "runs.sqlite");
    const children: ChildProcess[] = [];
    try {
      const first = launch("./engine-boundary.fixture.ts", [
        path,
        boundary,
        "crash",
      ]);
      children.push(first);
      expect(await message(first)).toBe(boundary);
      await kill(first);
      expect(first.signalCode).toBe("SIGKILL");
      const restarted = launch("./engine-boundary.fixture.ts", [
        path,
        boundary,
        "restart",
      ]);
      children.push(restarted);
      const exited = once(restarted, "exit");
      const result = (await message(restarted)) as {
        status: string;
        before: unknown;
        recovered: unknown;
        effects: { id: string; attempts: number }[];
        activeVisits: unknown[];
      };
      expect(result.status).toBe("completed");
      expect(result.activeVisits).toEqual([]);
      if (boundary === "fanout" || boundary === "after-pause")
        expect(result.effects).toEqual([
          {
            id: JSON.stringify(["shipment-1", "second", 1]),
            attempts: boundary === "fanout" ? 2 : 1,
          },
          { id: JSON.stringify(["shipment-1", "start", 1]), attempts: 1 },
        ]);
      else {
        expect(result.effects).toHaveLength(boundary === "after-claim" ? 1 : 2);
        expect(result.effects.every((effect) => effect.attempts === 1)).toBe(
          true,
        );
      }
      if (boundary === "paused-after-child")
        expect(result.recovered).toEqual(result.before);
      expect((await exited)[0]).toBe(0);
    } finally {
      for (const child of children) await kill(child);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
it("requests from separate processes converge through the single Heddle writer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "heddle-requests-"));
  const store = new RunStore(join(directory, "runs.sqlite"));
  const children: ChildProcess[] = [];
  try {
    const engine = new WorkflowEngine(store, {
      resolveBlueprint: () =>
        Promise.resolve({
          id: "shipment",
          nodes: [{ id: "inspect", uses: "pass" }],
          edges: [],
        }),
      nodes: {
        pass: async ({ await: pause }) => {
          await pause({ kind: "pass" });
        },
      },
    });
    await engine.start({
      id: "shipment-1",
      blueprintId: "shipment",
      commit: "commit-a",
    });
    const requests = [0, 1].map(() => {
      const child = launch("./engine-request.fixture.ts");
      children.push(child);
      return message(child);
    });
    const outcomes = await Promise.all(
      (await Promise.all(requests)).map((request) =>
        engine.resume(request as ResumeInput),
      ),
    );
    expect(outcomes.sort()).toEqual(["applied", "late-wakeup"]);
    expect(
      store.events("shipment-1").filter((event) => event.type === "resume"),
    ).toHaveLength(1);
    expect(
      store
        .events("shipment-1")
        .filter((event) => event.type === "late-wakeup"),
    ).toHaveLength(1);
    expect(store.get("shipment-1").status).toBe("completed");
  } finally {
    for (const child of children) await kill(child);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
