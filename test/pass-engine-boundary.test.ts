// ---
// relationships:
//   verifies: engine-and-run-model
// ---
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RunStore,
  WorkflowEngine,
  type EngineOptions,
  type Run,
} from "../src/engine/index.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture(
  onBoundary: (
    run: Run,
    store: RunStore,
    engine: WorkflowEngine,
  ) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "engine-boundary-"));
  cleanup.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const store = new RunStore(join(root, "runs.sqlite"));
  cleanup.push(() => {
    store.close();
  });
  const dispatched: string[] = [];
  const options: EngineOptions = {
    resolveBlueprint: () =>
      Promise.resolve({
        id: "inspection",
        nodes: [
          { id: "inspect", uses: "pass" },
          { id: "finish", uses: "finish" },
        ],
        edges: [
          {
            source: "inspect",
            target: "finish",
            condition: "result.output.handoff",
          },
        ],
      }),
    nodes: {
      pass: async (context) => {
        await context.await({ kind: "pass", threadId: "thread" });
      },
      finish: () => {
        dispatched.push("finish");
        return Promise.resolve(null);
      },
    },
    onBoundary: (run) => onBoundary(run, store, engine),
  };
  const engine = new WorkflowEngine(store, options);
  return { store, engine, options, dispatched };
}

it("activates only after the awaiting commit and releases traversal before immediate handoff", async () => {
  const observed: string[] = [];
  const f = fixture(async (run, store, engine) => {
    observed.push(run.status);
    if (run.status !== "awaiting") return;
    expect(store.awaiting(run.id)).toHaveLength(1);
    expect(store.active.has(run.id)).toBe(false);
    expect(store.events(run.id).some((event) => event.type === "pause")).toBe(
      true,
    );
    await engine.resume({
      runId: run.id,
      nodeId: "inspect",
      result: "handoff",
    });
  });
  expect(
    (
      await f.engine.start({
        id: "run",
        blueprintId: "inspection",
        commit: "pinned",
      })
    ).status,
  ).toBe("completed");
  expect(observed).toEqual(["running", "awaiting", "resuming", "completed"]);
  expect(f.dispatched).toEqual(["finish"]);
});

it("retires a queued claimed pass before its next node dispatches", async () => {
  const observed: string[] = [];
  const f = fixture((run, store) => {
    if (run.status === "resuming") {
      expect(store.awaiting(run.id)).toEqual([]);
      observed.push("retired");
    }
    return Promise.resolve();
  });
  f.options.nodes = {
    ...f.options.nodes,
    finish: () => {
      observed.push("finish");
      return Promise.resolve(null);
    },
  };
  await f.engine.start({
    id: "run",
    blueprintId: "inspection",
    commit: "pinned",
  });
  f.engine.pauseInstance("run");
  expect(
    await f.engine.resume({
      runId: "run",
      nodeId: "inspect",
      result: "handoff",
    }),
  ).toBe("held");
  await f.engine.resumeInstance("run");
  expect(observed).toEqual(["retired", "finish"]);
});

it("reconciles paused and terminal runs on repeated restart recovery", async () => {
  const observed: string[] = [];
  const f = fixture((run) => {
    observed.push(`${run.status}:${String(run.paused)}`);
    return Promise.resolve();
  });
  await f.engine.start({
    id: "run",
    blueprintId: "inspection",
    commit: "pinned",
  });
  f.engine.pauseInstance("run");
  observed.length = 0;
  const recovered = new WorkflowEngine(f.store, f.options);
  await recovered.recover();
  await recovered.recover();
  expect(observed).toEqual(["awaiting:true", "awaiting:true"]);
  f.store.status("run", "failed");
  await recovered.recover();
  expect(observed.at(-1)).toBe("failed:true");
});

it("fails an adapter start and retries cleanup in the failed state", async () => {
  const observed: string[] = [];
  const f = fixture((run) => {
    observed.push(run.status);
    return run.status === "awaiting"
      ? Promise.reject(new Error("registration failed"))
      : Promise.resolve();
  });
  expect(
    (
      await f.engine.start({
        id: "run",
        blueprintId: "inspection",
        commit: "pinned",
      })
    ).status,
  ).toBe("failed");
  expect(observed).toEqual(["running", "awaiting", "failed"]);
  expect(
    f.store.events("run").filter((event) => event.type === "failure"),
  ).toHaveLength(1);
  expect(f.dispatched).toEqual([]);
});

it("does not execute nodes after retirement fails at a claimed boundary", async () => {
  const f = fixture((run) =>
    run.status === "resuming"
      ? Promise.reject(new Error("cleanup failed"))
      : Promise.resolve(),
  );
  await f.engine.start({
    id: "run",
    blueprintId: "inspection",
    commit: "pinned",
  });
  await f.engine.resume({ runId: "run", nodeId: "inspect", result: "handoff" });
  expect(f.store.get("run").status).toBe("failed");
  expect(f.dispatched).toEqual([]);
});
