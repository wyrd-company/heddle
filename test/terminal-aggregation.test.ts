// ---
// relationships:
//   verifies:
//     - node-types
//     - engine-and-run-model
// ---
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowBlueprint } from "flowcraft";
import { afterEach, expect, it } from "vitest";
import {
  RunStore,
  WorkflowEngine,
  type EngineOptions,
} from "../src/engine/index.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required fixture value is absent");
  return value;
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function setup(blueprints: Record<string, WorkflowBlueprint>) {
  const directory = mkdtempSync(join(tmpdir(), "heddle-result-"));
  cleanups.push(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  let store: RunStore;
  const options: EngineOptions = {
    resolveBlueprint: (_commit, id) =>
      Promise.resolve(required(blueprints[id])),
    nodes: {
      pass: async ({ await: pause }) => {
        await pause({ kind: "pass" });
      },
    },
  };
  function open() {
    store = new RunStore(join(directory, "runs.sqlite"));
    cleanups.push(() => {
      store.close();
    });
    return { store, engine: new WorkflowEngine(store, options) };
  }
  return {
    ...open(),
    reopen: () => {
      store.close();
      return open();
    },
  };
}
const leaf = {
  id: "inspection",
  outputs: { result: {} },
  nodes: [
    { id: "work", uses: "pass" },
    {
      id: "finish",
      uses: "terminal-result",
      params: { value: { from: "work.payload" } },
    },
  ],
  edges: [{ source: "work", target: "finish" }],
};
const parallel: WorkflowBlueprint = {
  id: "parcel",
  nodes: [
    { id: "left", uses: "child-run", params: { blueprint: "inspection" } },
    { id: "right", uses: "child-run", params: { blueprint: "inspection" } },
    {
      id: "combine",
      uses: "aggregate",
      params: {
        bindings: {
          condition: { node: "right", path: "payload.result" },
          history: { node: "left", path: "payload.result" },
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
    { source: "left", target: "combine" },
    { source: "right", target: "combine" },
    { source: "combine", target: "finish" },
  ],
};

it("returns single terminal data through declared child outputs and preserves explicit mappings", async () => {
  const parent: WorkflowBlueprint = {
    id: "parcel",
    nodes: [
      {
        id: "inspect",
        uses: "child-run",
        params: {
          blueprint: "inspection",
          outputs: { result: "result", legacy: "work.payload.grade" },
        },
      },
      {
        id: "finish",
        uses: "terminal-result",
        params: { value: { from: "inspect.payload" } },
      },
    ],
    edges: [{ source: "inspect", target: "finish" }],
  };
  const { store, engine } = setup({ parcel: parent, inspection: leaf });
  const run = await engine.start({ blueprintId: "parcel", commit: "commit-a" });
  const child = required(
    required(store.awaiting(run.id)[0]).details.childRunId,
  );
  await engine.resume({
    runId: child,
    nodeId: "work",
    result: "handoff",
    payload: { grade: "stable" },
  });
  expect(store.get(run.id)).toMatchObject({
    status: "completed",
    context: {
      result: { result: { grade: "stable" }, legacy: "stable" },
      inspect: { completed: true, payload: { result: { grade: "stable" } } },
    },
  });
  expect(store.get(child).context["result"]).toEqual({ grade: "stable" });
});

it.each(["left", "right"])(
  "aggregates named results in authored order when %s completes first across restart",
  async (first) => {
    const harness = setup({ parcel: parallel, inspection: leaf });
    const run = await harness.engine.start({
      blueprintId: "parcel",
      commit: "commit-a",
    });
    const children = Object.fromEntries(
      harness.store
        .awaiting(run.id)
        .map((row) => [row.nodeId, required(row.details.childRunId)]),
    );
    const second = first === "left" ? "right" : "left";
    await harness.engine.resume({
      runId: required(children[first]),
      nodeId: "work",
      result: "handoff",
      payload: first,
    });
    expect(harness.store.get(run.id).status).toBe("awaiting");
    expect(harness.store.get(run.id).context["combine"]).toBeUndefined();
    const { engine, store } = harness.reopen();
    await engine.recover();
    expect(store.get(run.id).context["combine"]).toBeUndefined();
    await engine.resume({
      runId: required(children[second]),
      nodeId: "work",
      result: "handoff",
      payload: second,
    });
    const final = store.get(run.id);
    expect(final.status).toBe("completed");
    expect(final.context["result"]).toEqual({
      condition: "right",
      history: "left",
    });
    expect(Object.keys(final.context["result"] as object)).toEqual([
      "condition",
      "history",
    ]);
    expect(final.context["combine"]).toEqual(final.context["result"]);
  },
);

it("a terminal does not cancel a paused sibling and a second terminal fails after restart", async () => {
  const blueprint: WorkflowBlueprint = {
    id: "parcel",
    nodes: [
      { id: "early", uses: "terminal-result", params: { value: false } },
      { id: "later", uses: "pass" },
      { id: "late", uses: "terminal-result", params: { value: 42 } },
    ],
    edges: [{ source: "later", target: "late" }],
  };
  const harness = setup({ parcel: blueprint });
  const run = await harness.engine.start({
    blueprintId: "parcel",
    commit: "commit-a",
  });
  expect(run.status).toBe("awaiting");
  expect(run.context["result"]).toBe(false);
  expect(harness.store.awaiting(run.id).map((row) => row.nodeId)).toEqual([
    "later",
  ]);
  const { engine, store } = harness.reopen();
  await engine.resume({ runId: run.id, nodeId: "later", result: "handoff" });
  expect(store.get(run.id).status).toBe("failed");
  expect(JSON.stringify(store.events(run.id))).toContain(
    "Node 'late' execution failed",
  );
});

it.each([null, false, 0, "", [], {}])(
  "preserves a present terminal value %j",
  async (value) => {
    const { engine } = setup({
      parcel: {
        id: "parcel",
        nodes: [{ id: "finish", uses: "terminal-result", params: { value } }],
        edges: [],
      },
    });
    const run = await engine.start({
      blueprintId: "parcel",
      commit: "commit-a",
    });
    expect(run.status).toBe("completed");
    expect(run.context["result"]).toEqual(value);
    expect(run.context["finish"]).toEqual(value);
  },
);

it.each(["terminal", "aggregate"])(
  "rejects missing resolved %s values",
  async (kind) => {
    const blueprint = structuredClone(parallel);
    if (kind === "terminal")
      required(blueprint.nodes[3]).params = { value: { from: "absent" } };
    else
      required(blueprint.nodes[2]).params = {
        bindings: {
          condition: { node: "right", path: "payload.missing" },
          history: { node: "left" },
        },
      };
    const { store, engine } = setup({ parcel: blueprint, inspection: leaf });
    const run = await engine.start({
      blueprintId: "parcel",
      commit: "commit-a",
    });
    const children = store
      .awaiting(run.id)
      .map((row) => required(row.details.childRunId));
    for (const child of children)
      await engine.resume({
        runId: child,
        nodeId: "work",
        result: "handoff",
        payload: null,
      });
    expect(store.get(run.id).status).toBe("failed");
    expect(JSON.stringify(store.events(run.id))).toContain(
      kind === "terminal"
        ? "Node 'finish' execution failed"
        : "Node 'combine' execution failed",
    );
  },
);

it("keeps terminal data when a paused sibling has the authored id result", async () => {
  const blueprint: WorkflowBlueprint = {
    id: "parcel",
    nodes: [
      {
        id: "finish",
        uses: "terminal-result",
        params: { value: { decision: "stable" } },
      },
      { id: "result", uses: "pass" },
    ],
    edges: [],
  };
  const harness = setup({ parcel: blueprint });
  const run = await harness.engine.start({
    blueprintId: "parcel",
    commit: "commit-a",
  });
  const { engine, store } = harness.reopen();
  await engine.resume({
    runId: run.id,
    nodeId: "result",
    result: "handoff",
    payload: { decision: "different" },
  });
  expect(store.get(run.id)).toMatchObject({
    status: "completed",
    context: {
      result: { decision: "stable" },
      "_outputs.result": { handoff: true, payload: { decision: "different" } },
    },
  });
});
