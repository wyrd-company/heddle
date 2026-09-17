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
} from "../src/engine/index.js";
import { drainQueued } from "../src/engine/claims.js";
import { createRun } from "../src/engine/create-run.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const quick: EngineNode = () => Promise.resolve("done");
const pass: EngineNode = async ({ await: pause }) => {
  await pause({ kind: "pass" });
};
function setup(
  blueprints: WorkflowBlueprint[],
  nodes: Record<string, EngineNode> = {},
  clock = () => 0,
) {
  const directory = mkdtempSync(join(tmpdir(), "heddle-owner-"));
  cleanups.push(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, "runs.sqlite");
  const store = new RunStore(path);
  cleanups.push(() => {
    store.close();
  });
  const resolveBlueprint = (_commit: string, id: string) => {
    const found = blueprints.find((item) => item.id === id);
    if (!found) return Promise.reject(new Error("Blueprint not found"));
    return Promise.resolve(found);
  };
  const engine = new WorkflowEngine(store, {
    resolveBlueprint,
    nodes: { quick, pass, ...nodes },
    clock,
  });
  return { engine, store, path, resolveBlueprint };
}
function fanout(second = "pass"): WorkflowBlueprint {
  return {
    id: "collection",
    nodes: [
      { id: "start", uses: "quick" },
      { id: "first", uses: "pass" },
      { id: "second", uses: second, params: { deadline: 100 } },
      { id: "middle", uses: "slow" },
      { id: "finish", uses: "quick" },
    ],
    edges: [
      { source: "start", target: "first" },
      { source: "start", target: "second" },
      { source: "first", target: "middle", condition: "result.output.handoff" },
      {
        source: "second",
        target: "finish",
        condition: "result.output.timeout",
      },
    ],
  };
}
const child: WorkflowBlueprint = {
  id: "inspection",
  nodes: [{ id: "inspect", uses: "quick" }],
  edges: [],
};
function parent(id = "container", childId = "inspection"): WorkflowBlueprint {
  return {
    id,
    nodes: [
      { id: "child", uses: "child-run", params: { blueprint: childId } },
      { id: "finish", uses: "quick" },
    ],
    edges: [
      {
        source: "child",
        target: "finish",
        condition: "result.output.completed or result.output.failed",
      },
    ],
  };
}
it("retains and drains a sibling deadline arriving while another node traverses", async () => {
  const entered = deferred();
  const release = deferred();
  let now = 0;
  const { engine, store } = setup(
    [fanout()],
    {
      slow: async () => {
        entered.resolve();
        await release.promise;
        return null;
      },
    },
    () => now,
  );
  const run = await engine.start({
    blueprintId: "collection",
    commit: "commit-a",
  });
  const first = engine.resume({
    runId: run.id,
    nodeId: "first",
    result: "handoff",
  });
  try {
    await entered.promise;
    now = 100;
    await engine.tick();
    expect(store.db.prepare("SELECT * FROM wakeups").all()).toHaveLength(1);
    expect(store.db.prepare("SELECT * FROM held_resumes").all()).toHaveLength(
      1,
    );
  } finally {
    release.resolve();
    await first;
  }
  expect(store.get(run.id).status).toBe("completed");
  expect(store.get(run.id).context["second"]).toEqual({
    timeout: true,
    payload: { due: 100 },
  });
  expect(store.db.prepare("SELECT * FROM held_resumes").all()).toEqual([]);
  await engine.tick();
  expect(store.db.prepare("SELECT * FROM wakeups").all()).toEqual([]);
});
it("an earlier traversal cannot release a later traversal owned by the same writer", async () => {
  const childEntered = deferred(),
    childRelease = deferred();
  const parentEntered = deferred(),
    parentRelease = deferred();
  let calls = 0;
  const outer = fanout("child-run");
  const childNode = outer.nodes[2];
  if (!childNode) throw new Error("Missing child node");
  childNode.params = { blueprint: "inspection" };
  const inner = { ...child, nodes: [{ id: "inspect", uses: "slow-child" }] };
  const { engine, store } = setup([outer, inner], {
    "slow-child": async () => {
      childEntered.resolve();
      await childRelease.promise;
      return null;
    },
    slow: async () => {
      calls++;
      parentEntered.resolve();
      await parentRelease.promise;
      return null;
    },
  });
  const starting = engine.start({
    id: "collection-1",
    blueprintId: "collection",
    commit: "commit-a",
  });
  let resuming: Promise<unknown> | undefined;
  let recovering: Promise<unknown> | undefined;
  try {
    await childEntered.promise;
    resuming = engine.resume({
      runId: "collection-1",
      nodeId: "first",
      result: "handoff",
    });
    await parentEntered.promise;
    childRelease.resolve();
    await starting;
    recovering = engine.recover();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(calls).toBe(1);
    expect(store.active.has("collection-1")).toBe(true);
  } finally {
    childRelease.resolve();
    parentRelease.resolve();
    await starting;
    await resuming;
    await recovering;
  }
});
it("an unresolved child routes failed and records attention without stranding its parent", async () => {
  const { engine, store } = setup([parent("container", "missing")]);
  const run = await engine.start({
    blueprintId: "container",
    commit: "commit-a",
  });
  expect(run.status).toBe("completed");
  expect(run.context["child"]).toMatchObject({
    failed: true,
    payload: { message: "Blueprint not found" },
  });
  expect(store.events(run.id).some((event) => event.type === "attention")).toBe(
    true,
  );
});
it("recovery isolates a run failure and still recovers later runs", async () => {
  const { engine, store, resolveBlueprint } = setup([child]);
  for (const id of ["broken", "later"])
    await createRun(store, resolveBlueprint, {
      id,
      rootId: id,
      parentId: null,
      parentNodeId: null,
      blueprintId: "inspection",
      commit: "commit-a",
    });
  store.status("broken", "awaiting");
  store.recordAwaiting(
    { runId: "broken", nodeId: "inspect", visit: 1, details: { kind: "pass" } },
    0,
  );
  store.db.prepare("INSERT INTO held_resumes(run_id,request) VALUES (?,?)").run(
    "broken",
    JSON.stringify({
      runId: "broken",
      nodeId: "inspect",
      result: "handoff",
      visit: 1,
    }),
  );
  store.db.exec(
    "CREATE TRIGGER reject_claim BEFORE UPDATE OF status ON runs WHEN NEW.id='broken' AND NEW.status='resuming' BEGIN SELECT RAISE(ABORT, 'injected claim failure'); END",
  );
  await engine.recover();
  expect(store.get("broken").status).toBe("failed");
  expect(
    store.events("broken").some((event) => event.type === "attention"),
  ).toBe(true);
  expect(store.get("later").status).toBe("completed");
});
it("resuming one instance does not recover an unrelated running instance", async () => {
  let calls = 0;
  const { engine, store, resolveBlueprint } = setup([child], {
    quick: () => {
      calls++;
      return Promise.resolve(null);
    },
  });
  for (const id of ["selected", "other"])
    await createRun(store, resolveBlueprint, {
      id,
      rootId: id,
      parentId: null,
      parentNodeId: null,
      blueprintId: "inspection",
      commit: "commit-a",
    });
  engine.pauseInstance("selected");
  await engine.resumeInstance("selected");
  expect(calls).toBe(1);
  expect(store.get("other").status).toBe("running");
});
it("a child resolved after its parent pauses inherits the pause before dispatch", async () => {
  const entered = deferred(),
    release = deferred();
  const { store } = setup([]);
  let effects = 0;
  const engine = new WorkflowEngine(store, {
    resolveBlueprint: async (_commit, id) => {
      if (id === "container") return parent();
      entered.resolve();
      await release.promise;
      return child;
    },
    nodes: {
      quick: () => {
        effects++;
        return Promise.resolve(null);
      },
    },
  });
  const starting = engine.start({
    id: "container-1",
    blueprintId: "container",
    commit: "commit-a",
  });
  try {
    await entered.promise;
    engine.pauseInstance("container-1");
  } finally {
    release.resolve();
    await starting;
  }
  const created = store.list().find((run) => run.parentId === "container-1");
  expect(created?.paused).toBe(true);
  expect(effects).toBe(0);
  await engine.resumeInstance("container-1");
  expect(store.get("container-1").status).toBe("completed");
  expect(effects).toBe(2);
});
it("a pause between due selection and claim retains the row and consumes the held request once", async () => {
  const blueprint: WorkflowBlueprint = {
    id: "nap",
    nodes: [
      { id: "rest", uses: "sleep", params: { duration: 100 } },
      { id: "finish", uses: "quick" },
    ],
    edges: [
      {
        source: "rest",
        target: "finish",
        condition: "result.output.completed",
      },
    ],
  };
  const { engine, store } = setup([blueprint], {}, () => 100);
  const run = await engine.start({ blueprintId: "nap", commit: "commit-a" });
  await engine.wakeups.tick(200, (request) => {
    engine.pauseInstance(run.id);
    return engine.resume(request);
  });
  expect(store.db.prepare("SELECT * FROM wakeups").all()).toHaveLength(1);
  expect(store.db.prepare("SELECT * FROM held_resumes").all()).toHaveLength(1);
  await engine.resumeInstance(run.id);
  expect(store.db.prepare("SELECT * FROM held_resumes").all()).toEqual([]);
  const resumes = store
    .events(run.id)
    .filter((event) => event.type === "resume" || event.type === "late-wakeup");
  await engine.resumeInstance(run.id);
  expect(
    store
      .events(run.id)
      .filter(
        (event) => event.type === "resume" || event.type === "late-wakeup",
      ),
  ).toEqual(resumes);
});
it("mapped child outputs stay under payload and cannot become routing flags", async () => {
  const inner = {
    ...child,
    outputs: Object.fromEntries(
      ["completed", "failed", "payload", "timeout", "handoff"].map((key) => [
        key,
        {},
      ]),
    ),
  };
  const { engine, store } = setup([parent(), inner], {
    quick: ({ context }) => {
      for (const key of [
        "completed",
        "failed",
        "payload",
        "timeout",
        "handoff",
      ])
        context[key] = "value";
      return Promise.resolve(null);
    },
  });
  const run = await engine.start({
    blueprintId: "container",
    commit: "commit-a",
  });
  expect(run.status).toBe("completed");
  expect(store.get(run.id).context["child"]).toEqual({
    completed: true,
    payload: {
      completed: "value",
      failed: "value",
      payload: "value",
      timeout: "value",
      handoff: "value",
    },
  });
});
it("all handles for one file share the writer and its active traversal ownership", () => {
  const { store, path } = setup([]);
  const other = new RunStore(path);
  try {
    expect(other.db).toBe(store.db);
    expect(other.active).toBe(store.active);
  } finally {
    other.close();
  }
  expect(store.list()).toEqual([]);
});

it("queued requests keep their original visit when the node awaits again", async () => {
  const entered = deferred(),
    release = deferred();
  const blueprint = fanout();
  const second = blueprint.nodes.find((node) => node.id === "second");
  if (!second) throw new Error("Missing second node");
  second.config = { joinStrategy: "any" };
  blueprint.edges.push({
    source: "second",
    target: "second",
    condition: "result.output.handoff",
  });
  const { engine, store } = setup([blueprint], {
    slow: async () => {
      entered.resolve();
      await release.promise;
      return null;
    },
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
  try {
    await entered.promise;
    for (let attempt = 0; attempt < 2; attempt++)
      expect(
        await engine.resume({
          runId: run.id,
          nodeId: "second",
          result: "handoff",
        }),
      ).toBe("held");
  } finally {
    release.resolve();
    await first;
  }
  expect(store.awaiting(run.id)[0]?.visit).toBe(2);
  expect(
    store.events(run.id).filter((event) => event.type === "late-wakeup"),
  ).toHaveLength(1);
});

it("rejects a resume for a paused sibling after the run has failed", async () => {
  const blueprint = fanout("broken");
  const { engine, store } = setup([blueprint], {
    broken: () => Promise.reject(new Error("Failed node")),
  });
  const run = await engine.start({
    blueprintId: blueprint.id,
    commit: "commit-a",
  });
  expect(run.status).toBe("failed");
  expect(store.awaiting(run.id).map((item) => item.nodeId)).toEqual(["first"]);
  expect(
    await engine.resume({ runId: run.id, nodeId: "first", result: "handoff" }),
  ).toBe("late-wakeup");
  expect(store.db.prepare("SELECT * FROM held_resumes").all()).toEqual([]);
  expect(store.get(run.id).status).toBe("failed");
});

it("queue deletion and resume claim roll back together when the writer cannot delete", async () => {
  const { engine, store } = setup([
    {
      id: "inspection",
      nodes: [{ id: "inspect", uses: "pass", params: { deadline: 0 } }],
      edges: [],
    },
  ]);
  const run = await engine.start({
    blueprintId: "inspection",
    commit: "commit-a",
  });
  engine.pauseInstance(run.id);
  await engine.resume({
    runId: run.id,
    nodeId: "inspect",
    result: "timeout",
    wakeupId: Number(store.db.prepare("SELECT id FROM wakeups").get()?.["id"]),
  });
  store.db.prepare("UPDATE runs SET paused=0 WHERE id=?").run(run.id);
  const before = store.get(run.id);
  store.db.exec(
    "CREATE TRIGGER retain_request BEFORE DELETE ON held_resumes BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END",
  );
  try {
    await expect(
      drainQueued(store, run.id, () => Promise.resolve()),
    ).rejects.toThrow("injected delete failure");
    expect(store.get(run.id)).toEqual(before);
    expect(store.db.prepare("SELECT * FROM wakeups").all()).toHaveLength(1);
    expect(store.awaiting(run.id)).toHaveLength(1);
    expect(
      store.events(run.id).filter((event) => event.type === "resume"),
    ).toEqual([]);
    expect(store.db.prepare("SELECT * FROM held_resumes").all()).toHaveLength(
      1,
    );
  } finally {
    store.db.exec("DROP TRIGGER retain_request");
  }
  await engine.recover();
  expect(store.get(run.id).status).toBe("completed");
  expect(
    store.events(run.id).filter((event) => event.type === "resume"),
  ).toHaveLength(1);
});

it("repeated busy ticks queue one deadline and retire it without a false late wakeup", async () => {
  const entered = deferred(),
    release = deferred();
  let now = 0;
  const { engine, store } = setup(
    [fanout()],
    {
      slow: async () => {
        entered.resolve();
        await release.promise;
        return null;
      },
    },
    () => now,
  );
  const run = await engine.start({
    blueprintId: "collection",
    commit: "commit-a",
  });
  const work = engine.resume({
    runId: run.id,
    nodeId: "first",
    result: "handoff",
  });
  try {
    await entered.promise;
    now = 100;
    await engine.tick();
    await engine.tick();
    await engine.tick();
    expect(store.db.prepare("SELECT * FROM held_resumes").all()).toHaveLength(
      1,
    );
    expect(
      store.events(run.id).filter((event) => event.type === "held-wakeup"),
    ).toHaveLength(1);
    expect(store.db.prepare("SELECT * FROM wakeups").all()).toHaveLength(1);
  } finally {
    release.resolve();
    await work;
  }
  expect(store.db.prepare("SELECT * FROM held_resumes").all()).toEqual([]);
  expect(store.db.prepare("SELECT * FROM wakeups").all()).toEqual([]);
  await engine.tick();
  expect(
    store.events(run.id).filter((event) => event.type === "late-wakeup"),
  ).toEqual([]);
  expect(
    store
      .events(run.id)
      .filter(
        (event) =>
          event.type === "resume" &&
          (event.payload as { result: string }).result === "timeout",
      ),
  ).toHaveLength(1);
});

it("settle applies two queued sibling requests in arrival order", async () => {
  const entered = deferred(),
    release = deferred();
  const blueprint = fanout();
  blueprint.nodes.push({ id: "third", uses: "pass" });
  blueprint.edges.push({ source: "start", target: "third" });
  const { engine, store } = setup([blueprint], {
    slow: async () => {
      entered.resolve();
      await release.promise;
      return null;
    },
  });
  const run = await engine.start({
    blueprintId: blueprint.id,
    commit: "commit-a",
  });
  const work = engine.resume({
    runId: run.id,
    nodeId: "first",
    result: "handoff",
  });
  try {
    await entered.promise;
    expect(
      await engine.resume({
        runId: run.id,
        nodeId: "third",
        result: "handoff",
      }),
    ).toBe("held");
    expect(
      await engine.resume({
        runId: run.id,
        nodeId: "second",
        result: "timeout",
      }),
    ).toBe("held");
  } finally {
    release.resolve();
    await work;
  }
  expect(
    store
      .events(run.id)
      .filter((e) => e.type === "resume")
      .map((e) => (e.payload as { nodeId: string }).nodeId),
  ).toEqual(["first", "third", "second"]);
  expect(store.db.prepare("SELECT * FROM held_resumes").all()).toEqual([]);
  expect(store.get(run.id).status).toBe("completed");
});

it("a live child output projection failure raises parent attention and routes failed", async () => {
  const inner: WorkflowBlueprint = {
    id: "inspection",
    nodes: [{ id: "work", uses: "pass" }],
    edges: [],
  };
  const outer = parent();
  const definition = outer.nodes[0];
  if (!definition) throw new Error("Missing child");
  definition.params = {
    blueprint: "inspection",
    outputs: { total: "$sum(work)" },
  };
  const { engine, store } = setup([inner, outer]);
  const run = await engine.start({
    blueprintId: "container",
    commit: "commit-a",
  });
  const childId = String(store.awaiting(run.id)[0]?.details.childRunId);
  expect(
    await engine.resume({
      runId: childId,
      nodeId: "work",
      result: "handoff",
      payload: { value: "not a number" },
    }),
  ).toBe("applied");
  expect(store.get(childId).status).toBe("completed");
  expect(store.get(run.id).status).toBe("completed");
  expect(store.get(run.id).context["child"]).toMatchObject({
    failed: true,
    payload: { message: expect.any(String) as unknown },
  });
  expect(
    store.events(run.id).filter((e) => e.type === "attention"),
  ).toHaveLength(1);
  expect(store.awaiting(run.id)).toEqual([]);
});

it("a retired deadline identity cannot consume a later visit deadline", async () => {
  let now = 0;
  const blueprint: WorkflowBlueprint = {
    id: "rest",
    nodes: [
      {
        id: "rest",
        uses: "sleep",
        config: { joinStrategy: "any" },
        params: { duration: 1 },
      },
    ],
    edges: [
      { source: "rest", target: "rest", condition: "result.output.completed" },
    ],
  };
  const { engine, store } = setup([blueprint], {}, () => now);
  const run = await engine.start({ blueprintId: "rest", commit: "commit-a" });
  const old = engine.wakeups.due(1)[0];
  if (!old) throw new Error("Missing wakeup");
  now = 1;
  await engine.tick();
  const current = store.db.prepare("SELECT * FROM wakeups").all();
  expect(current).toHaveLength(1);
  expect(await engine.resume({ ...old, wakeupId: old.id })).toBe("late-wakeup");
  expect(store.db.prepare("SELECT * FROM wakeups").all()).toEqual(current);
  now = 2;
  await engine.tick();
  expect(store.awaiting(run.id)[0]?.visit).toBe(3);
});

it("a failed branch stops dispatch of its unfinished siblings", async () => {
  let effects = 0;
  const blueprint = fanout("broken");
  blueprint.nodes.push({ id: "third", uses: "effect" });
  blueprint.edges.push({ source: "start", target: "third" });
  const { engine, store } = setup([blueprint], {
    broken: () => Promise.reject(new Error("Failed node")),
    effect: () => {
      effects++;
      return Promise.resolve(null);
    },
  });
  const run = await engine.start({
    blueprintId: blueprint.id,
    commit: "commit-a",
  });
  expect(run.status).toBe("failed");
  expect(effects).toBe(0);
  expect(
    store
      .events(run.id)
      .filter(
        (event) =>
          event.type === "node-start" &&
          (event.payload as { nodeId: string }).nodeId === "third",
      ),
  ).toEqual([]);
});

it("discards a queued idle after activity and delivers the postponed wakeup once", async () => {
  const entered = deferred(),
    release = deferred();
  let now = 0;
  const blueprint = fanout();
  const second = blueprint.nodes[2];
  const edge = blueprint.edges[3];
  if (!second || !edge) throw new Error("Missing idle branch");
  second.params = { inactivity: 100 };
  edge.condition = "result.output.idle";
  const { engine, store } = setup(
    [blueprint],
    {
      slow: async () => {
        entered.resolve();
        await release.promise;
        return null;
      },
    },
    () => now,
  );
  const run = await engine.start({
    blueprintId: "collection",
    commit: "commit-a",
  });
  const work = engine.resume({
    runId: run.id,
    nodeId: "first",
    result: "handoff",
  });
  let postponed: unknown;
  try {
    await entered.promise;
    now = 100;
    await engine.tick();
    const original = store.db.prepare("SELECT * FROM wakeups").get();
    expect(original).toMatchObject({ due: 100 });
    expect(store.db.prepare("SELECT * FROM held_resumes").all()).toHaveLength(
      1,
    );
    engine.wakeups.activity(run.id, "second", 150);
    postponed = store.db.prepare("SELECT * FROM wakeups").get();
    expect(postponed).toEqual({ ...original, due: 250 });
  } finally {
    now = 160;
    release.resolve();
    await work;
  }
  expect(store.awaiting(run.id).map((item) => item.nodeId)).toEqual(["second"]);
  expect(store.get(run.id).context["second"]).toBeUndefined();
  expect(store.db.prepare("SELECT * FROM held_resumes").all()).toEqual([]);
  expect(store.db.prepare("SELECT * FROM wakeups").all()).toEqual([postponed]);
  expect(
    store.events(run.id).filter((event) => event.type === "late-wakeup"),
  ).toMatchObject([{ payload: { result: "idle", payload: { due: 100 } } }]);
  now = 249;
  await engine.tick();
  expect(store.awaiting(run.id).map((item) => item.nodeId)).toEqual(["second"]);
  now = 250;
  await engine.tick();
  await engine.tick();
  await engine.recover();
  expect(store.get(run.id).status).toBe("completed");
  expect(store.get(run.id).context["second"]).toEqual({
    idle: true,
    payload: { due: 250 },
  });
  expect(store.db.prepare("SELECT * FROM wakeups").all()).toEqual([]);
  expect(
    store
      .events(run.id)
      .filter(
        (event) =>
          event.type === "resume" &&
          (event.payload as { result: string }).result === "idle",
      ),
  ).toHaveLength(1);
});

it("applies an external idle result without a scheduler identity", async () => {
  const { engine, store } = setup([
    {
      id: "inspection",
      nodes: [{ id: "inspect", uses: "pass", params: { inactivity: 100 } }],
      edges: [],
    },
  ]);
  const run = await engine.start({
    blueprintId: "inspection",
    commit: "commit-a",
  });
  expect(
    await engine.resume({
      runId: run.id,
      nodeId: "inspect",
      result: "idle",
      payload: { reason: "observed" },
    }),
  ).toBe("applied");
  expect(store.get(run.id).context["inspect"]).toEqual({
    idle: true,
    payload: { reason: "observed" },
  });
});
