// ---
// relationships:
//   verifies: engine-and-run-model
// ---
import type { WorkflowBlueprint } from "flowcraft";
const { WorkflowEngine, RunStore } = (await import(
  new URL("../dist/index.js", import.meta.url).href
)) as typeof import("../src/index.js");
const [path, mode] = process.argv.slice(2);
if (!path) throw new Error("Database path required");
process.on("message", () => {
  /* Retain IPC until the observed process kill. */
});
const store = new RunStore(path);
const parent: WorkflowBlueprint = {
  id: "shipment",
  nodes: [
    { id: "weight", uses: "child-run", params: { blueprint: "inspection" } },
    { id: "size", uses: "child-run", params: { blueprint: "inspection" } },
    {
      id: "combine",
      uses: "aggregate",
      params: {
        bindings: {
          dimensions: { node: "size", path: "payload.result" },
          mass: { node: "weight", path: "payload.result" },
        },
      },
    },
    {
      id: "finish",
      uses: "terminal-result",
      params: { value: { from: "combine" } },
    },
  ],
  edges: [
    { source: "weight", target: "combine" },
    { source: "size", target: "combine" },
    { source: "combine", target: "finish" },
  ],
};
const child = {
  id: "inspection",
  outputs: { result: {} },
  nodes: [
    { id: "read", uses: "pass" },
    {
      id: "finish",
      uses: "terminal-result",
      params: { value: { from: "read.payload" } },
    },
  ],
  edges: [{ source: "read", target: "finish" }],
};
const engine = new WorkflowEngine(store, {
  resolveBlueprint: (_commit, id) => {
    if (mode === "restart")
      throw new Error("Recovery must use the pinned stored blueprints");
    return Promise.resolve(id === "shipment" ? parent : child);
  },
  nodes: {
    pass: async ({ await: pause }) => {
      await pause({ kind: "pass" });
    },
  },
});
if (mode === "crash") {
  await engine.start({
    id: "shipment-1",
    blueprintId: "shipment",
    commit: "commit-a",
  });
  const weight = store
    .awaiting("shipment-1")
    .find((row) => row.nodeId === "weight")?.details.childRunId;
  if (!weight) throw new Error("Weight child is absent");
  await engine.resume({
    runId: weight,
    nodeId: "read",
    result: "handoff",
    payload: { amount: 7 },
  });
  process.send?.({
    status: store.get("shipment-1").status,
    first: store.get(weight).context["result"],
    combined: store.get("shipment-1").context["combine"] ?? null,
  });
} else {
  await engine.recover();
  const before = store.get("shipment-1");
  const size = store.awaiting("shipment-1").find((row) => row.nodeId === "size")
    ?.details.childRunId;
  if (!size) throw new Error("Size child is absent");
  await engine.resume({
    runId: size,
    nodeId: "read",
    result: "handoff",
    payload: { width: 3 },
  });
  const final = store.get("shipment-1");
  process.send?.({
    before: before.status,
    status: final.status,
    result: final.context["result"],
    keys: Object.keys(final.context["result"] as object),
  });
  store.close();
  process.disconnect();
}
