// ---
// relationships:
//   verifies: engine-and-run-model
// ---
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowBlueprint } from "flowcraft";
import { afterEach, expect, it } from "vitest";
import {
  WorkflowEngine,
  RunStore,
  type EngineNode,
  type Data,
} from "../src/engine/index.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture(
  blueprints: WorkflowBlueprint[],
  nodes: Record<string, EngineNode> = {},
  clock = () => 0,
) {
  const directory = mkdtempSync(join(tmpdir(), "heddle-engine-"));
  cleanups.push(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, "runs.sqlite");
  const store = new RunStore(path);
  cleanups.push(() => {
    store.close();
  });
  const resolutions: string[] = [];
  const resolveBlueprint = (commit: string, id: string) => {
    resolutions.push(commit);
    const blueprint = blueprints.find((item) => item.id === id);
    if (!blueprint) throw new Error(`Missing fixture ${id}`);
    return Promise.resolve(blueprint);
  };
  const engine = new WorkflowEngine(store, { resolveBlueprint, nodes, clock });
  return { engine, store, path, resolutions, resolveBlueprint };
}
const pass: EngineNode = async ({ await: pause, effectKey }) => {
  await pause({ kind: "pass", threadId: effectKey, issueId: "item-1" });
};
const done: EngineNode = ({ context }) => {
  context["result"] = "accepted";
  return Promise.resolve({ value: 42 });
};
function waiting(params: Data = {}): WorkflowBlueprint {
  return {
    id: "inspection",
    nodes: [
      { id: "inspect", uses: "pass", params },
      { id: "finish", uses: "done" },
    ],
    edges: [
      {
        source: "inspect",
        target: "finish",
        condition: "result.output.handoff",
      },
      {
        source: "inspect",
        target: "finish",
        condition: "result.output.timeout",
      },
      { source: "inspect", target: "finish", condition: "result.output.idle" },
    ],
  };
}
it("runs two child blueprints and returns declared outputs at the same pinned commit", async () => {
  const child = { ...waiting(), outputs: { result: { type: "string" } } };
  const parent: WorkflowBlueprint = {
    id: "collection",
    nodes: [
      {
        id: "first",
        uses: "child-run",
        params: { blueprint: "inspection", inputs: { item: { from: "item" } } },
      },
      {
        id: "second",
        uses: "child-run",
        params: { blueprint: "inspection", outputs: { answer: "result" } },
      },
      { id: "finish", uses: "done" },
    ],
    edges: [
      {
        source: "first",
        target: "second",
        condition: "result.output.completed",
      },
      {
        source: "second",
        target: "finish",
        condition: "result.output.completed",
      },
    ],
  };
  const { engine, store, resolutions } = fixture([parent, child], {
    pass,
    done,
  });
  let run = await engine.start({
    id: "collection-1",
    blueprintId: parent.id,
    commit: "commit-a",
    context: { item: { name: "book" } },
  });
  expect(run.status).toBe("awaiting");
  for (const nodeId of ["first", "second"]) {
    const item = store.awaiting(run.id)[0];
    expect(item?.nodeId).toBe(nodeId);
    const childId = item?.details.childRunId ?? "";
    expect(store.get(childId).status).toBe("awaiting");
    expect(store.findAwaiting("childRunId", childId)).toHaveLength(1);
    await engine.resume({
      runId: childId,
      nodeId: "inspect",
      result: "handoff",
      payload: { approved: true },
    });
  }
  run = store.get(run.id);
  expect(run.status).toBe("completed");
  expect(run.context["first"]).toMatchObject({
    completed: true,
    payload: { result: "accepted" },
    result: "accepted",
  });
  expect(run.context["second"]).toMatchObject({
    completed: true,
    payload: { answer: "accepted" },
    answer: "accepted",
  });
  expect(resolutions).toEqual(["commit-a", "commit-a", "commit-a"]);
});
it("arbitrates parallel resume callers on separate connections to one SQLite file", async () => {
  const { engine, store, path, resolveBlueprint } = fixture([waiting()], {
    pass,
    done,
  });
  const otherStore = new RunStore(path);
  cleanups.push(() => {
    otherStore.close();
  });
  const other = new WorkflowEngine(otherStore, {
    resolveBlueprint,
    nodes: { pass, done },
  });
  const run = await engine.start({
    blueprintId: "inspection",
    commit: "commit-a",
  });
  const request = {
    runId: run.id,
    nodeId: "inspect",
    result: "handoff",
    payload: { selected: 1 },
  };
  expect(
    await Promise.all([
      engine.resume(request),
      other.resume({ ...request, payload: { selected: 2 } }),
    ]),
  ).toEqual(["applied", "late-wakeup"]);
  expect(store.get(run.id).context["inspect"]).toEqual({
    handoff: true,
    payload: { selected: 1 },
  });
  expect(
    store.events(run.id).filter((event) => event.type === "late-wakeup"),
  ).toHaveLength(1);
});
it("fires authored elapsed and inactivity wakeups and postpones inactivity on observed activity", async () => {
  let now = 0;
  const { engine, store } = fixture(
    [waiting({ deadline: "PT20S", inactivity: "PT5S" })],
    { pass, done },
    () => now,
  );
  const run = await engine.start({
    blueprintId: "inspection",
    commit: "commit-a",
  });
  const pending = store.awaiting(run.id)[0];
  expect(
    store.findAwaiting("threadId", pending?.details.threadId ?? ""),
  ).toHaveLength(1);
  expect(store.findAwaiting("issueId", "item-1")).toHaveLength(1);
  now = 4000;
  engine.wakeups.activity(run.id, "inspect", now);
  now = 5000;
  await engine.tick();
  expect(store.get(run.id).status).toBe("awaiting");
  now = 9000;
  await engine.tick();
  expect(store.get(run.id).context["inspect"]).toMatchObject({ idle: true });
  now = 20000;
  await engine.tick();
  expect(
    store.events(run.id).filter((event) => event.type === "late-wakeup"),
  ).toHaveLength(1);
  const elapsed = await engine.start({
    blueprintId: "inspection",
    commit: "commit-a",
  });
  engine.wakeups.activity(elapsed.id, "inspect", 40000);
  now = 40000;
  await engine.tick();
  expect(store.get(elapsed.id).context["inspect"]).toMatchObject({
    timeout: true,
  });
});
it("records attention when no outgoing edge handles a resumed result", async () => {
  const { engine, store } = fixture([waiting()], { pass, done });
  const run = await engine.start({
    blueprintId: "inspection",
    commit: "commit-a",
  });
  await engine.resume({ runId: run.id, nodeId: "inspect", result: "unknown" });
  expect(store.get(run.id).status).toBe("failed");
  expect(store.events(run.id).some((event) => event.type === "attention")).toBe(
    true,
  );
});
it("holds wakeups and external resumes while paused and requeues them on instance resume", async () => {
  let now = 0;
  const { engine, store } = fixture(
    [waiting({ deadline: 100 })],
    { pass, done },
    () => now,
  );
  const run = await engine.start({
    blueprintId: "inspection",
    commit: "commit-a",
  });
  engine.pauseInstance(run.id);
  now = 100;
  await engine.tick();
  expect(store.get(run.id).status).toBe("awaiting");
  expect(
    await engine.resume({
      runId: run.id,
      nodeId: "inspect",
      result: "handoff",
    }),
  ).toBe("held");
  await engine.resumeInstance(run.id);
  expect(store.get(run.id).context["inspect"]).toMatchObject({ handoff: true });
  expect(
    store.events(run.id).some((event) => event.type === "late-wakeup"),
  ).toBe(true);
});
it("wraps sleep with a durable row and resumes after constructing a fresh engine", async () => {
  const blueprint: WorkflowBlueprint = {
    id: "rest",
    nodes: [
      { id: "rest", uses: "sleep", params: { duration: "PT2S" } },
      { id: "finish", uses: "done" },
    ],
    edges: [
      {
        source: "rest",
        target: "finish",
        condition: "result.output.completed",
      },
    ],
  };
  const { engine, store, resolveBlueprint } = fixture([blueprint], { done });
  const run = await engine.start({ blueprintId: "rest", commit: "commit-a" });
  const fresh = new WorkflowEngine(store, {
    resolveBlueprint,
    nodes: { done },
    clock: () => 2000,
  });
  await fresh.recover();
  await fresh.tick();
  expect(store.get(run.id).status).toBe("completed");
});

it("retains the resolved blueprint snapshot when the live resolver changes", async () => {
  const blueprint = waiting();
  const { engine, store, resolveBlueprint, resolutions } = fixture(
    [blueprint],
    { pass, done },
  );
  const run = await engine.start({
    id: "item-1",
    blueprintId: blueprint.id,
    commit: "commit-a",
  });
  blueprint.edges = [];
  const restarted = new WorkflowEngine(store, {
    resolveBlueprint,
    nodes: { pass, done },
  });
  await restarted.recover();
  await restarted.resume({
    runId: run.id,
    nodeId: "inspect",
    result: "handoff",
  });
  expect(store.get(run.id).context["finish"]).toEqual({ value: 42 });
  expect(resolutions).toEqual(["commit-a"]);
});
it("rejects run identity reuse across blueprint or commit partitions without changing the original", async () => {
  const { engine, store } = fixture(
    [waiting(), { ...waiting(), id: "alternate" }],
    { pass, done },
  );
  const input = {
    id: "item-1",
    blueprintId: "inspection",
    commit: "commit-a",
    context: { value: 1 },
  };
  const run = await engine.start(input);
  for (const change of [
    { blueprintId: "alternate" },
    { commit: "commit-b" },
    { context: { value: 2 } },
  ]) {
    await expect(engine.start({ ...input, ...change })).rejects.toThrow(
      "different invocation",
    );
    expect(store.get(run.id)).toEqual(run);
  }
  await engine.start(input);
  expect(
    store.events(run.id).filter((event) => event.type === "node-start"),
  ).toHaveLength(1);
});
it.each(["subflow", "SubflowNode"])(
  "excludes %s from runtime blueprints",
  async (uses) => {
    const { engine } = fixture([
      { id: "excluded", nodes: [{ id: "node", uses }], edges: [] },
    ]);
    await expect(
      engine.start({ blueprintId: "excluded", commit: "commit-a" }),
    ).rejects.toThrow("subflow is excluded");
  },
);
it("rejects action edges even when their action is empty", async () => {
  const blueprint = waiting();
  const edge = blueprint.edges[0];
  if (!edge) throw new Error("Missing fixture edge");
  edge.action = "";
  const { engine } = fixture([blueprint]);
  await expect(
    engine.start({ blueprintId: blueprint.id, commit: "commit-a" }),
  ).rejects.toThrow("Action edges");
});
it("does not apply a previous visit deadline to a later visit of the same node", async () => {
  let now = 0;
  const blueprint: WorkflowBlueprint = {
    id: "revision",
    nodes: [
      {
        id: "inspect",
        uses: "pass",
        params: { deadline: "PT10S" },
        config: { joinStrategy: "any" },
      },
      { id: "finish", uses: "done" },
    ],
    edges: [
      {
        source: "inspect",
        target: "inspect",
        condition: "result.output.handoff",
      },
      {
        source: "inspect",
        target: "finish",
        condition: "result.output.timeout",
      },
    ],
  };
  const { engine, store } = fixture([blueprint], { pass, done }, () => now);
  const run = await engine.start({
    blueprintId: blueprint.id,
    commit: "commit-a",
  });
  now = 5000;
  await engine.resume({ runId: run.id, nodeId: "inspect", result: "handoff" });
  expect(store.awaiting(run.id)[0]?.visit).toBe(2);
  now = 10000;
  await engine.tick();
  expect(store.get(run.id).status).toBe("awaiting");
  expect(
    store.events(run.id).filter((event) => event.type === "late-wakeup"),
  ).toHaveLength(1);
  now = 15000;
  await engine.tick();
  expect(store.get(run.id).status).toBe("completed");
});
it("holds the next node dispatch while an in-flight node finishes", async () => {
  let release: () => void = () => {
    throw new Error("not started");
  };
  let signalEntry: () => void = () => {
    throw new Error("not initialized");
  };
  const entered = new Promise<void>((resolve) => {
    signalEntry = resolve;
  });
  const blocking: EngineNode = async () => {
    signalEntry();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { saved: true };
  };
  const { engine, store } = fixture(
    [
      {
        id: "delivery",
        nodes: [
          { id: "prepare", uses: "blocking" },
          { id: "finish", uses: "done" },
        ],
        edges: [{ source: "prepare", target: "finish" }],
      },
    ],
    { blocking, done },
  );
  const executing = engine.start({
    id: "item-1",
    blueprintId: "delivery",
    commit: "commit-a",
  });
  await entered;
  engine.pauseInstance("item-1");
  release();
  await executing;
  expect(store.get("item-1").context["finish"]).toBeUndefined();
  expect(
    store.events("item-1").filter((event) => event.type === "node-start"),
  ).toHaveLength(1);
  await engine.resumeInstance("item-1");
  expect(store.get("item-1").status).toBe("completed");
  expect(store.get("item-1").context["finish"]).toEqual({ value: 42 });
});
it("uses UTC calendar arithmetic for month deadlines and renewed inactivity", async () => {
  let now = Date.parse("2024-01-31T00:00:00Z");
  const { engine, store } = fixture(
    [waiting({ deadline: "P1M", inactivity: "P1M" })],
    { pass, done },
    () => now,
  );
  const run = await engine.start({
    blueprintId: "inspection",
    commit: "commit-a",
  });
  now = Date.parse("2024-02-29T00:00:00Z");
  engine.wakeups.activity(run.id, "inspect", now);
  const wakeups = store.db
    .prepare("SELECT result,due FROM wakeups ORDER BY result")
    .all();
  expect(wakeups).toEqual([
    { result: "idle", due: Date.parse("2024-03-29T00:00:00Z") },
    { result: "timeout", due: now },
  ]);
  await engine.tick();
  expect(store.get(run.id).context["inspect"]).toMatchObject({ timeout: true });
});

it("raises attention when a resumed result selects more than one edge", async () => {
  const blueprint = waiting();
  blueprint.nodes.push({ id: "other", uses: "done" });
  blueprint.edges.push({
    source: "inspect",
    target: "other",
    condition: "result.output.handoff",
  });
  const { engine, store } = fixture([blueprint], { pass, done });
  const run = await engine.start({
    blueprintId: blueprint.id,
    commit: "commit-a",
  });
  await engine.resume({ runId: run.id, nodeId: "inspect", result: "handoff" });
  expect(store.get(run.id).status).toBe("failed");
  expect(store.get(run.id).context["finish"]).toBeUndefined();
});
it("rechecks a due inactivity row moved forward while another wakeup is running", async () => {
  let now = 0;
  let postpone = () => {
    /* Installed after both runs await. */
  };
  const finish: EngineNode = () => {
    postpone();
    return Promise.resolve({ done: true });
  };
  const { engine, store } = fixture(
    [waiting({ inactivity: "PT5S" })],
    { pass, done: finish },
    () => now,
  );
  await engine.start({
    id: "first",
    blueprintId: "inspection",
    commit: "commit-a",
  });
  const second = await engine.start({
    id: "second",
    blueprintId: "inspection",
    commit: "commit-a",
  });
  now = 5000;
  postpone = () => {
    engine.wakeups.activity(second.id, "inspect", now);
  };
  await engine.tick();
  expect(store.get(second.id).status).toBe("awaiting");
});
it("does not move inactivity backwards for old observed activity", async () => {
  const { engine, store } = fixture(
    [waiting({ inactivity: "PT5S" })],
    { pass, done },
    () => 10000,
  );
  const run = await engine.start({
    blueprintId: "inspection",
    commit: "commit-a",
  });
  engine.wakeups.activity(run.id, "inspect", 1000);
  expect(store.db.prepare("SELECT due FROM wakeups").get()?.["due"]).toBe(
    15000,
  );
  expect(() => {
    engine.wakeups.activity(run.id, "inspect", Infinity);
  }).toThrow("finite observed time");
});
it("resumes a parent through its failed-child result", async () => {
  const parent: WorkflowBlueprint = {
    id: "container",
    nodes: [
      { id: "child", uses: "child-run", params: { blueprint: "inspection" } },
      { id: "finish", uses: "done" },
    ],
    edges: [
      { source: "child", target: "finish", condition: "result.output.failed" },
    ],
  };
  const fail: EngineNode = () => Promise.reject(new Error("Cannot inspect"));
  const { engine, store } = fixture([parent, waiting()], { pass: fail, done });
  const run = await engine.start({
    blueprintId: parent.id,
    commit: "commit-a",
  });
  expect(run.status).toBe("completed");
  expect(run.context["child"]).toMatchObject({ failed: true });
  const child = store.list().find((item) => item.parentId === run.id);
  if (!child) throw new Error("Missing child fixture");
  expect(store.events(child.id).some((event) => event.type === "failure")).toBe(
    true,
  );
});

it("pauses descendants and releases their held due wakeups on instance resume", async () => {
  let now = 0;
  const parent: WorkflowBlueprint = {
    id: "container",
    nodes: [
      { id: "child", uses: "child-run", params: { blueprint: "inspection" } },
      { id: "finish", uses: "done" },
    ],
    edges: [
      {
        source: "child",
        target: "finish",
        condition: "result.output.completed",
      },
    ],
  };
  const { engine, store } = fixture(
    [parent, waiting({ deadline: "PT1S" })],
    { pass, done },
    () => now,
  );
  const run = await engine.start({
    blueprintId: parent.id,
    commit: "commit-a",
  });
  engine.pauseInstance(run.id);
  now = 1000;
  await engine.tick();
  expect(
    store.list().every((item) => item.paused && item.status === "awaiting"),
  ).toBe(true);
  await engine.resumeInstance(run.id);
  expect(
    store.list().every((item) => !item.paused && item.status === "completed"),
  ).toBe(true);
});
it("creates no wakeups without authored durations", async () => {
  const { engine, store } = fixture([waiting()], { pass, done });
  await engine.start({ blueprintId: "inspection", commit: "commit-a" });
  expect(store.db.prepare("SELECT * FROM wakeups").all()).toEqual([]);
});
it.each([-1, Infinity, "-PT1S", "invalid"])(
  "rejects invalid authored duration %s without persisting a wakeup",
  async (deadline) => {
    const { engine, store } = fixture([waiting({ deadline })], { pass, done });
    const run = await engine.start({
      blueprintId: "inspection",
      commit: "commit-a",
    });
    expect(run.status).toBe("failed");
    expect(store.db.prepare("SELECT * FROM wakeups").all()).toEqual([]);
  },
);
it("raises attention for a node failure after the node marks itself awaiting", async () => {
  const broken: EngineNode = async ({ await: pause }) => {
    await pause({ kind: "pass" });
    throw new Error("Cannot persist effect");
  };
  const { engine, store } = fixture([waiting()], { pass: broken, done });
  const run = await engine.start({
    blueprintId: "inspection",
    commit: "commit-a",
  });
  expect(run.status).toBe("failed");
  expect(store.events(run.id).some((event) => event.type === "attention")).toBe(
    true,
  );
});
it("does not hide a real in-flight failure when the instance is paused", async () => {
  let freeze = () => {
    /* Assigned before execution begins. */
  };
  const broken: EngineNode = () => {
    freeze();
    return Promise.reject(new Error("Observed failure"));
  };
  const { engine, store } = fixture([waiting()], { pass: broken, done });
  freeze = () => {
    engine.pauseInstance("item-1");
  };
  const run = await engine.start({
    id: "item-1",
    blueprintId: "inspection",
    commit: "commit-a",
  });
  expect(run.status).toBe("failed");
  expect(store.events(run.id).some((event) => event.type === "failure")).toBe(
    true,
  );
});

it("arbitrates per run while another paused node still exists", async () => {
  let enter: () => void = () => {
    throw new Error("uninitialized");
  };
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release: () => void = () => {
    throw new Error("uninitialized");
  };
  const blocking: EngineNode = async () => {
    enter();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return null;
  };
  const blueprint: WorkflowBlueprint = {
    id: "parallel",
    nodes: [
      { id: "start", uses: "done" },
      { id: "first", uses: "pass" },
      { id: "second", uses: "pass" },
      { id: "middle", uses: "blocking" },
      { id: "finish", uses: "done" },
    ],
    edges: [
      { source: "start", target: "first" },
      { source: "start", target: "second" },
      { source: "first", target: "middle", condition: "result.output.handoff" },
      {
        source: "second",
        target: "finish",
        condition: "result.output.handoff",
      },
    ],
  };
  const { engine, store, path, resolveBlueprint } = fixture([blueprint], {
    pass,
    done,
    blocking,
  });
  const otherStore = new RunStore(path);
  cleanups.push(() => {
    otherStore.close();
  });
  const other = new WorkflowEngine(otherStore, {
    resolveBlueprint,
    nodes: { pass, done, blocking },
  });
  const run = await engine.start({
    blueprintId: blueprint.id,
    commit: "commit-a",
  });
  const first = engine.resume({
    runId: run.id,
    nodeId: "first",
    result: "handoff",
  });
  await entered;
  try {
    expect(
      await other.resume({
        runId: run.id,
        nodeId: "second",
        result: "handoff",
      }),
    ).toBe("late-wakeup");
  } finally {
    release();
    await first;
  }
  expect(store.get(run.id).status).toBe("awaiting");
  await engine.resume({ runId: run.id, nodeId: "second", result: "handoff" });
  expect(store.get(run.id).status, JSON.stringify(store.events(run.id))).toBe(
    "completed",
  );
});
