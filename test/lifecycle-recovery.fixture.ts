// ---
// relationships:
//   verifies: engine-and-run-model
// ---
const { RunStore, WorkflowEngine, InstanceStore } = (await import(
  new URL("../dist/index.js", import.meta.url).href
)) as typeof import("../src/index.js");
const { issue } = (await import(
  new URL("./lifecycle-snapshot.fixture.ts", import.meta.url).href
)) as typeof import("./lifecycle-snapshot.fixture.js");
const [path, boundary, mode] = process.argv.slice(2);
if (!path) throw new Error("Database path required");
process.on("message", () => {
  /* IPC remains available until the test observes and kills this process. */
});
const store = new RunStore(path);
const instances = new InstanceStore(store.db);
const engine = new WorkflowEngine(store, {
  resolveBlueprint: (commit, id) => {
    if (mode === "restart")
      throw new Error("Recovery resolved a live blueprint");
    if (commit !== "commit-a") throw new Error("Wrong pinned commit");
    return Promise.resolve(
      id === "selection"
        ? {
            id,
            nodes: [
              {
                id: "start",
                uses: "lifecycle-start",
                params: {
                  blueprint: "collection",
                  inputs: { settings: { from: "settings" } },
                },
              },
            ],
            edges: [],
          }
        : {
            id,
            kind: "process",
            nodes: [
              { id: "inspect", uses: "wait" },
              { id: "finish", uses: "record" },
            ],
            edges: [
              {
                source: "inspect",
                target: "finish",
                condition: "result.output.completed",
              },
            ],
          },
    );
  },
  nodes: {
    record: ({ context }) => {
      context["effect"] = {
        issue: context["issue"],
        settings: context["settings"],
      };
      return Promise.resolve("recorded");
    },
  },
});
if (mode === "crash") {
  instances.discover(issue);
  const transaction = store.transaction.bind(store);
  store.transaction = <T>(operation: () => T): T => {
    const value = transaction(operation);
    const last = store.events("intake-1").at(-1);
    const links = store.lifecycleStarts();
    const lifecycleLast = links[0]
      ? store.events(links[0].lifecycleRunId).at(-1)
      : undefined;
    if (
      (boundary === "after-create" && last?.type === "lifecycle-started") ||
      (boundary === "after-intake" && last?.type === "completed") ||
      (boundary === "after-lifecycle-pause" && lifecycleLast?.type === "pause")
    ) {
      process.send?.({ boundary, links });
      process.kill(process.pid, "SIGSTOP");
    }
    return value;
  };
  await engine.start({
    id: "intake-1",
    blueprintId: "selection",
    commit: "commit-a",
    context: {
      issue,
      settings: { category: "rare" },
    },
  });
  throw new Error("Crash boundary was not reached");
} else {
  const links = store.lifecycleStarts();
  const id = links[0]?.lifecycleRunId ?? "missing";
  const beforeAttachment = instances.get(issue.id).runId;
  instances.update({ ...issue, title: "Changed after lifecycle creation" });
  // Composition attaches the durable lifecycle; it does not create a replacement.
  instances.attach(issue.id, id);
  await engine.recover();
  const before = store.get(id);
  await engine.resume({ runId: id, nodeId: "inspect", result: "completed" });
  const lifecycle = store.get(id);
  const intake = store.get("intake-1");
  const count = store.list().length;
  const events = store.events("intake-1");
  await engine.recover();
  process.send?.({
    links,
    count,
    attachment: {
      before: beforeAttachment,
      after: instances.get(issue.id).runId,
      currentTitle: instances.get(issue.id).issue.title,
    },
    before: { status: before.status, initialContext: before.initialContext },
    lifecycle: {
      id,
      rootId: lifecycle.rootId,
      parentId: lifecycle.parentId,
      commit: lifecycle.commit,
      status: lifecycle.status,
      initialContext: lifecycle.initialContext,
      effect: lifecycle.context["effect"],
    },
    intake: {
      status: intake.status,
      output: intake.context["start"],
      starts: events.filter((event) => event.type === "lifecycle-started")
        .length,
    },
    effectCount: store
      .events(id)
      .filter(
        (event) =>
          event.type === "node-end" &&
          (event.payload as { nodeId: string }).nodeId === "finish",
      ).length,
    unchanged:
      JSON.stringify(store.get("intake-1")) === JSON.stringify(intake) &&
      JSON.stringify(store.events("intake-1")) === JSON.stringify(events),
  });
  store.close();
  process.disconnect();
}
