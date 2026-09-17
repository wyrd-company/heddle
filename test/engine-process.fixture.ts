// ---
// relationships:
//   verifies: engine-and-run-model
// ---
import { DatabaseSync } from "node:sqlite";
import type { EngineNode } from "../src/engine/index.js";
const { WorkflowEngine, RunStore } = (await import(
  new URL("../dist/engine/index.js", import.meta.url).href
)) as typeof import("../src/engine/index.js");

const [path, mode] = process.argv.slice(2);
if (!path) throw new Error("Fixture requires database path");
const store = new RunStore(path);
const effects = new DatabaseSync(`${path}.effects`);
effects.exec(
  "CREATE TABLE IF NOT EXISTS effects (id TEXT PRIMARY KEY,attempts INTEGER NOT NULL)",
);
const record: EngineNode = async ({ effectKey, nodeId }) => {
  effects
    .prepare(
      "INSERT INTO effects VALUES (?,1) ON CONFLICT(id) DO UPDATE SET attempts=attempts+1",
    )
    .run(effectKey);
  if (
    (mode === "mid-node" && nodeId === "record") ||
    (mode === "resuming" && nodeId === "finish")
  ) {
    process.send?.(mode);
    await new Promise(() => {
      /* The parent kills the process at this boundary. */
    });
  }
  return { receipt: effectKey };
};
const pause: EngineNode = async ({ await: awaiting }) => {
  await awaiting({ kind: "pass", threadId: "sample-thread" });
};
const engine = new WorkflowEngine(store, {
  resolveBlueprint: () =>
    Promise.resolve({
      id: "delivery",
      nodes: [
        { id: "record", uses: "record" },
        { id: "approval", uses: "pass" },
        { id: "finish", uses: "finish" },
      ],
      edges: [
        { source: "record", target: "approval" },
        {
          source: "approval",
          target: "finish",
          condition: "result.output.handoff",
        },
      ],
    }),
  nodes: { record, pass: pause, finish: record },
});
if (mode === "resume") {
  await engine.recover();
  await engine.resume({
    runId: "delivery-1",
    nodeId: "approval",
    result: "handoff",
  });
  process.send?.({
    status: store.get("delivery-1").status,
    effects: effects.prepare("SELECT * FROM effects").all(),
  });
  effects.close();
  store.close();
} else {
  await engine.start({
    id: "delivery-1",
    blueprintId: "delivery",
    commit: "commit-a",
  });
  if (mode === "resuming")
    await engine.resume({
      runId: "delivery-1",
      nodeId: "approval",
      result: "handoff",
    });
  process.send?.("paused");
  process.on("message", () => {
    /* Keep the paused process available for SIGKILL. */
  });
}
