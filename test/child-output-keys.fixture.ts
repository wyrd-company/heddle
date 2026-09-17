// ---
// relationships:
//   verifies: engine-and-run-model
// ---
import type { WorkflowBlueprint } from "flowcraft";
const { WorkflowEngine, RunStore } = (await import(
  new URL("../dist/index.js", import.meta.url).href
)) as typeof import("../src/index.js");
const [path, mode, selection] = process.argv.slice(2);
if (!path) throw new Error("Database path required");
const values = Object.fromEntries<unknown>([
  ["draft-notes", "first edition"],
  ["draft.notes", { pages: 12 }],
  ["draft notes", ["ink", "paper"]],
  ['draft\\"notes', "escaped"],
  ["__proto__", { edition: 2 }],
  ["", "unnamed"],
  ["ordinary", false],
]);
const outputs =
  selection === "absent"
    ? Object.fromEntries<unknown>([
        ["__proto__", {}],
        ["ordinary", {}],
      ])
    : Object.fromEntries(Object.keys(values).map((key) => [key, {}]));
const mapping =
  selection === "empty"
    ? {}
    : selection === "authored"
      ? {
          difference: "9 - notes",
          dotted: "draft.notes",
          selected: '$lookup($, "draft-notes")',
          doubled: "$sum([2, 3]) * 2",
        }
      : undefined;
const parent: WorkflowBlueprint = {
  id: "collection",
  nodes: [
    {
      id: "inspect",
      uses: "child-run",
      params: {
        blueprint: "inspection",
        inputs:
          selection === "absent"
            ? { ordinary: false }
            : { ...values, draft: { notes: "nested" }, notes: 2 },
        ...(mapping === undefined ? {} : { outputs: mapping }),
      },
    },
    {
      id: "finish",
      uses: "terminal-result",
      params: { value: { from: "inspect.payload" } },
    },
  ],
  edges: [
    {
      source: "inspect",
      target: "finish",
      condition: "result.output.completed",
    },
  ],
};
const child = {
  id: "inspection",
  outputs,
  nodes: [
    { id: "approval", uses: "wait" },
    { id: "finish", uses: "terminal-result", params: { value: "accepted" } },
  ],
  edges: [
    {
      source: "approval",
      target: "finish",
      condition: "result.output.completed",
    },
  ],
};
const store = new RunStore(path);
const engine = new WorkflowEngine(store, {
  resolveBlueprint: (_commit, id) => {
    if (mode === "resume")
      throw new Error("Recovery must use stored snapshots");
    return Promise.resolve(id === "collection" ? parent : child);
  },
});
try {
  if (mode === "resume") await engine.recover();
  else
    await engine.start({
      id: "collection-1",
      blueprintId: "collection",
      commit: "snapshot-a",
    });
  const childRun = store.list().find((run) => run.parentId === "collection-1");
  if (!childRun) throw new Error("Child run missing");
  if (mode !== "pause") {
    await engine.resume({
      runId: childRun.id,
      nodeId: "approval",
      result: "completed",
    });
    const completed = store.get("collection-1");
    process.send?.({
      status: completed.status,
      result: completed.context["result"],
      completion: completed.context["inspect"],
      child: store.get(childRun.id).context,
      events: store
        .events("collection-1")
        .filter((event) => event.type === "resume"),
    });
  } else
    process.send?.({
      status: store.get("collection-1").status,
      child: childRun.status,
    });
} finally {
  store.close();
  process.disconnect();
}
