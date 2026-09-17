// ---
// relationships:
//   verifies: engine-and-run-model
// ---
const { WorkflowEngine, RunStore } = (await import(
  new URL("../dist/index.js", import.meta.url).href
)) as typeof import("../src/engine/index.js");

const [path, mode] = process.argv.slice(2);
if (!path) throw new Error("Fixture requires database path");
process.on("message", () => {
  /* Keep the writer alive until the parent observes and kills it. */
});
const store = new RunStore(path);
let now = 0;
let entered!: () => void;
const busy = new Promise<void>((resolve) => {
  entered = resolve;
});
const engine = new WorkflowEngine(store, {
  clock: () => now,
  resolveBlueprint: () =>
    Promise.resolve({
      id: "collection",
      nodes: [
        { id: "start", uses: "quick" },
        { id: "first", uses: "pass" },
        { id: "second", uses: "pass", params: { inactivity: 100 } },
        { id: "middle", uses: "slow" },
        { id: "finish", uses: "quick" },
      ],
      edges: [
        { source: "start", target: "first" },
        { source: "start", target: "second" },
        {
          source: "first",
          target: "middle",
          condition: "result.output.handoff",
        },
        { source: "second", target: "finish", condition: "result.output.idle" },
      ],
    }),
  nodes: {
    quick: () => Promise.resolve(null),
    pass: async ({ await: awaiting }) => {
      await awaiting({ kind: "pass" });
    },
    slow: async () => {
      if (mode === "queue") {
        entered();
        await new Promise(() => {
          /* The parent kills this traversal after its sibling queues idle. */
        });
      }
      return null;
    },
  },
});
function snapshot() {
  const run = store.get("collection-1");
  return {
    status: run.status,
    awaiting: store.awaiting(run.id).map((item) => item.nodeId),
    wakeups: store.db.prepare("SELECT id,due FROM wakeups").all(),
    queued: store.db
      .prepare("SELECT request FROM held_resumes")
      .all()
      .map((row) => JSON.parse(String(row["request"])) as unknown),
    idle: store
      .events(run.id)
      .filter(
        (event) =>
          event.type === "resume" &&
          (event.payload as { result: string }).result === "idle",
      ),
    late: store.events(run.id).filter((event) => event.type === "late-wakeup"),
  };
}
if (mode === "queue") {
  await engine.start({
    id: "collection-1",
    blueprintId: "collection",
    commit: "commit-a",
  });
  const work = engine.resume({
    runId: "collection-1",
    nodeId: "first",
    result: "handoff",
  });
  await busy;
  now = 100;
  await engine.tick();
  process.send?.(snapshot());
  await work;
} else if (mode === "activity") {
  engine.wakeups.activity("collection-1", "second", 150);
  process.send?.(snapshot());
} else if (mode === "drain") {
  now = 160;
  await engine.recover();
  process.send?.(snapshot());
} else if (mode === "deliver") {
  now = 249;
  await engine.recover();
  await engine.tick();
  const beforeDue = snapshot();
  now = 250;
  await engine.tick();
  await engine.tick();
  await engine.recover();
  process.send?.({ beforeDue, afterDue: snapshot() });
  store.close();
  process.disconnect();
} else {
  throw new Error("Unknown fixture mode");
}
