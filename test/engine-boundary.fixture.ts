// ---
// relationships:
//   verifies: engine-and-run-model
// ---
import { DatabaseSync } from "node:sqlite";
import type { EngineNode, ResumeInput, Run } from "../src/engine/index.js";
const { WorkflowEngine, RunStore } = (await import(
  new URL("../dist/index.js", import.meta.url).href
)) as typeof import("../src/index.js");
const [path, boundary, mode] = process.argv.slice(2);
if (!path) throw new Error("Database path required");
process.on("message", () => {
  /* Keep IPC alive until the observed kill. */
});
const store = new RunStore(path);
const effects = new DatabaseSync(`${path}.effects`);
effects.exec(
  "CREATE TABLE IF NOT EXISTS effects (id TEXT PRIMARY KEY,attempts INTEGER NOT NULL)",
);
async function stopAtBoundary(): Promise<never> {
  process.send?.(boundary);
  return new Promise(() => {
    /* The parent kills this exact child here. */
  });
}
const record: EngineNode = async ({ effectKey, nodeId }) => {
  effects
    .prepare(
      "INSERT INTO effects VALUES (?,1) ON CONFLICT(id) DO UPDATE SET attempts=attempts+1",
    )
    .run(effectKey);
  if (mode === "crash" && boundary === "fanout" && nodeId === "second")
    await stopAtBoundary();
  return "recorded";
};
const pass: EngineNode = async ({ await: pause }) => {
  await pause({ kind: "pass" });
};
const engine = new WorkflowEngine(store, {
  resolveBlueprint: async (_commit, id) => {
    if (id === "inspection") {
      if (mode === "crash" && boundary === "before-child")
        await stopAtBoundary();
      return { id, nodes: [{ id: "inspect", uses: "record" }], edges: [] };
    }
    if (boundary === "after-node")
      return {
        id,
        nodes: [
          { id: "start", uses: "record" },
          { id: "finish", uses: "record" },
        ],
        edges: [{ source: "start", target: "finish" }],
      };
    if (boundary === "after-claim")
      return {
        id,
        nodes: [
          { id: "inspect", uses: "pass" },
          { id: "finish", uses: "record" },
        ],
        edges: [
          {
            source: "inspect",
            target: "finish",
            condition: "result.output.handoff",
          },
        ],
      };
    if (boundary === "fanout" || boundary === "after-pause")
      return {
        id,
        nodes: [
          { id: "start", uses: "record" },
          { id: "first", uses: "pass" },
          { id: "second", uses: "record" },
        ],
        edges: [
          { source: "start", target: "first" },
          { source: "start", target: "second" },
        ],
      };
    return {
      id,
      nodes: [
        { id: "child", uses: "child-run", params: { blueprint: "inspection" } },
        { id: "finish", uses: "record" },
      ],
      edges: [
        {
          source: "child",
          target: "finish",
          condition: "result.output.completed",
        },
      ],
    };
  },
  nodes: { record, pass },
});
if (mode === "crash") {
  if (boundary === "after-node" || boundary === "after-pause") {
    const transaction = store.transaction.bind(store);
    store.transaction = <T>(operation: () => T): T => {
      const value = transaction(operation);
      const last = store.events("shipment-1").at(-1);
      if (
        (boundary === "after-node" && last?.type === "node-end") ||
        (boundary === "after-pause" && last?.type === "pause")
      ) {
        // Stop only this child immediately after COMMIT, before JS can advance.
        process.send?.(boundary);
        process.kill(process.pid, "SIGSTOP");
      }
      return value;
    };
  }
  if (boundary === "after-claim") {
    const target = engine as unknown as {
      execute: (id: string) => Promise<Run>;
    };
    const execute = target.execute.bind(engine);
    target.execute = async (id) => {
      if (store.get(id).checkpoint.nodeId === "inspect") await stopAtBoundary();
      return execute(id);
    };
  }
  if (boundary === "after-child" || boundary === "paused-after-child") {
    const resume = engine.resume.bind(engine);
    engine.resume = async (request: ResumeInput) => {
      if (request.nodeId === "child") {
        if (boundary === "paused-after-child")
          engine.pauseInstance("shipment-1");
        await stopAtBoundary();
      }
      return resume(request);
    };
  }
  await engine.start({
    id: "shipment-1",
    blueprintId: "shipment",
    commit: "commit-a",
  });
  if (boundary === "after-claim")
    await engine.resume({
      runId: "shipment-1",
      nodeId: "inspect",
      result: "handoff",
    });
  throw new Error(`Crash boundary was not reached: ${String(boundary)}`);
} else {
  const before = store
    .list()
    .map((run) => ({ id: run.id, events: store.events(run.id) }));
  await engine.recover();
  const recovered = store
    .list()
    .map((run) => ({ id: run.id, events: store.events(run.id) }));
  if (boundary === "paused-after-child")
    await engine.resumeInstance("shipment-1");
  if (boundary === "fanout" || boundary === "after-pause")
    await engine.resume({
      runId: "shipment-1",
      nodeId: "first",
      result: "handoff",
    });
  process.send?.({
    status: store.get("shipment-1").status,
    before,
    recovered,
    effects: effects.prepare("SELECT * FROM effects ORDER BY id").all(),
    activeVisits: store.db.prepare("SELECT * FROM visits WHERE active=1").all(),
  });
  store.close();
  effects.close();
  process.disconnect();
}
