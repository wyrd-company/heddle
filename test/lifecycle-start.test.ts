// ---
// relationships:
//   verifies:
//     - engine-and-run-model
//     - node-types
// ---
import { expect, it, onTestFinished } from "vitest";
import {
  deriveFlowcraftBlueprint,
  RunStore,
  WorkflowEngine,
  type Blueprint,
  type Data,
  type EngineNode,
  type HeddleFlowcraftBlueprint,
} from "../src/index.js";
import { lifecycleStart } from "../src/engine/lifecycle-start.js";

const issue = { id: "item-1", title: "Inspect a book", fields: { count: 3 } };
const target = (): HeddleFlowcraftBlueprint => ({
  id: "collection",
  kind: "process",
  nodes: [{ id: "inspect", uses: "wait" }],
  edges: [],
});
function intake(params: Data = { blueprint: "collection" }) {
  return {
    id: "selection",
    nodes: [{ id: "start", uses: "lifecycle-start", params }],
    edges: [],
  };
}
function harness(
  options: {
    params?: Data;
    blueprint?: HeddleFlowcraftBlueprint;
    nodes?: Record<string, EngineNode>;
  } = {},
) {
  const store = new RunStore(":memory:");
  onTestFinished(() => {
    store.close();
  });
  const resolutions: string[] = [];
  const engine = new WorkflowEngine(store, {
    resolveBlueprint: (commit, id) => {
      resolutions.push(`${commit}:${id}`);
      if (id === "selection") return Promise.resolve(intake(options.params));
      if (id !== "collection") throw new Error(`Unknown blueprint: ${id}`);
      return Promise.resolve(options.blueprint ?? target());
    },
    nodes: options.nodes ?? {},
  });
  const start = (context: Data = { issue }) =>
    engine.start({
      id: "intake-1",
      blueprintId: "selection",
      commit: "commit-a",
      context,
    });
  return { store, engine, resolutions, start };
}

it("starts an independent root with immutable mapped inputs and durable provenance", async () => {
  const { start, store, resolutions } = harness({
    params: {
      blueprint: { from: "selected" },
      inputs: { settings: { from: "settings" } },
    },
  });
  const source = {
    issue: structuredClone(issue),
    selected: "collection",
    settings: { category: "rare" },
  };
  const run = await start(source);
  expect(run.status).toBe("completed");
  const links = store.lifecycleStarts(run.id);
  expect(links).toEqual([
    {
      runId: run.id,
      nodeId: "start",
      visit: 1,
      lifecycleRunId: JSON.stringify([run.id, "start", 1]),
    },
  ]);
  const lifecycle = store.get(links[0]?.lifecycleRunId ?? "missing");
  expect(lifecycle).toMatchObject({
    rootId: lifecycle.id,
    parentId: null,
    parentNodeId: null,
    status: "awaiting",
    commit: "commit-a",
  });
  expect(lifecycle.initialContext).toEqual({
    issue,
    settings: { category: "rare" },
  });
  expect(run.context["start"]).toEqual({
    started: true,
    payload: { runId: lifecycle.id },
  });
  expect(store.awaiting(run.id)).toEqual([]);
  expect(resolutions).toEqual(["commit-a:selection", "commit-a:collection"]);
  source.issue.fields.count = 90;
  source.settings.category = "changed";
  expect(store.get(lifecycle.id).initialContext).toEqual({
    issue,
    settings: { category: "rare" },
  });
});

it.each([
  { blueprint: "../collection" },
  { blueprint: "" },
  { blueprint: 7 },
  { blueprint: "missing" },
  { blueprint: "collection", inputs: [] },
  { blueprint: "collection", inputs: null },
  { blueprint: "collection", inputs: { issue } },
  { blueprint: "collection", inputs: { missing: { from: "missing" } } },
])(
  "rejects invalid lifecycle params %j before target effects",
  async (params) => {
    let effects = 0;
    const blueprint = target();
    blueprint.nodes.splice(0, blueprint.nodes.length, {
      id: "effect",
      uses: "effect",
    });
    const { start, store, resolutions } = harness({
      params,
      blueprint,
      nodes: {
        effect: () => {
          effects++;
          return Promise.resolve(null);
        },
      },
    });
    const run = await start();
    expect(run.status).toBe("failed");
    expect(effects).toBe(0);
    if (params.blueprint !== "missing")
      expect(resolutions).toEqual(["commit-a:selection"]);
    expect(store.list()).toHaveLength(1);
    expect(store.lifecycleStarts()).toEqual([]);
    expect(store.events(run.id)).toContainEqual(
      expect.objectContaining({ type: "attention" }),
    );
  },
);

it.each(["helper", "stage", undefined])(
  "rejects target kind %s before creation",
  async (kind) => {
    const blueprint = { ...target(), kind } as HeddleFlowcraftBlueprint;
    const { start, store } = harness({ blueprint });
    expect((await start()).status).toBe("failed");
    expect(store.list()).toHaveLength(1);
    expect(store.lifecycleStarts()).toEqual([]);
  },
);

it("rejects a target resolver identity mismatch before creation", async () => {
  const { start, store } = harness({ blueprint: { ...target(), id: "other" } });
  expect((await start()).status).toBe("failed");
  expect(store.list()).toHaveLength(1);
});

it.each([undefined, {}, { id: "" }, { id: 9 }])(
  "requires an issue identity: %j",
  async (invalid) => {
    const { start, store } = harness();
    expect(
      (await start(invalid === undefined ? {} : { issue: invalid })).status,
    ).toBe("failed");
    expect(store.list()).toHaveLength(1);
  },
);

it("captures issue and input values before asynchronous target resolution", async () => {
  const { store, start } = harness();
  const original = await start();
  const currentIssue = { ...issue, title: "Updated description" };
  const inputs = { settings: { category: "rare" } };
  const created = await lifecycleStart(
    store,
    () => {
      currentIssue.title = "Changed during resolution";
      inputs.settings.category = "changed";
      return Promise.resolve(target());
    },
    {
      run: original,
      nodeId: "another-start",
      visit: 1,
      effectKey: "another-lifecycle",
      input: undefined,
      params: { blueprint: "collection", inputs },
      context: { issue: currentIssue },
      await: () => Promise.resolve(),
    },
  );
  expect(created).toEqual({
    started: true,
    payload: { runId: "another-lifecycle" },
  });
  expect(store.get("another-lifecycle").initialContext).toEqual({
    issue: { ...issue, title: "Updated description" },
    settings: { category: "rare" },
  });
});

it("rejects a changed issue identity before target resolution", async () => {
  const { store, start } = harness();
  const original = await start();
  let resolutions = 0;
  await expect(
    lifecycleStart(
      store,
      () => {
        resolutions++;
        return Promise.resolve(target());
      },
      {
        run: original,
        nodeId: "another-start",
        visit: 1,
        effectKey: "another-lifecycle",
        input: undefined,
        params: { blueprint: "collection" },
        context: { issue: { ...issue, id: "item-2" } },
        await: () => Promise.resolve(),
      },
    ),
  ).rejects.toThrow("intake issue identity");
  expect(resolutions).toBe(0);
  expect(store.list()).toHaveLength(2);
});

it("rolls target creation back if provenance cannot commit", async () => {
  const { store, start } = harness();
  store.db.exec(
    "CREATE TRIGGER reject_origin BEFORE INSERT ON lifecycle_starts BEGIN SELECT RAISE(ABORT, 'provenance unavailable'); END",
  );
  expect((await start()).status).toBe("failed");
  expect(store.list()).toHaveLength(1);
  expect(store.lifecycleStarts()).toEqual([]);
  expect(
    store.db.prepare("SELECT * FROM events WHERE type='start'").all(),
  ).toHaveLength(1);
});

it("does not report lifecycle execution failure as an intake failure", async () => {
  const blueprint = target();
  blueprint.nodes.splice(0, blueprint.nodes.length, {
    id: "effect",
    uses: "effect",
  });
  const { start, store } = harness({
    blueprint,
    nodes: { effect: () => Promise.reject(new Error("Inspection failed")) },
  });
  const run = await start();
  expect(run.status).toBe("completed");
  expect(
    store.get(store.lifecycleStarts()[0]?.lifecycleRunId ?? "missing").status,
  ).toBe("failed");
  expect(run.context["start"]).toMatchObject({ started: true });
});

it("pauses and resumes the lifecycle independently from its intake root", async () => {
  const { start, store, engine } = harness();
  const intake = await start();
  const lifecycleId = store.lifecycleStarts()[0]?.lifecycleRunId ?? "missing";
  engine.pauseInstance(lifecycleId);
  expect(store.get(intake.id).paused).toBe(false);
  expect(
    await engine.resume({
      runId: lifecycleId,
      nodeId: "inspect",
      result: "completed",
    }),
  ).toBe("held");
  await engine.resumeInstance(lifecycleId);
  expect(store.get(lifecycleId).status).toBe("completed");
  expect(store.get(intake.id)).toEqual(intake);
});

it("routes the authored synchronous started result", async () => {
  const blueprint: Blueprint = {
    id: "selection",
    kind: "helper",
    nodes: {
      start: { uses: "lifecycle-start", params: { blueprint: "collection" } },
      finish: { uses: "record" },
    },
    edges: [{ from: "start", to: "finish", when: "result.output.started" }],
  };
  const store = new RunStore(":memory:");
  onTestFinished(() => {
    store.close();
  });
  let observed: unknown;
  const engine = new WorkflowEngine(store, {
    resolveBlueprint: (_commit, id) =>
      Promise.resolve(
        id === "selection" ? deriveFlowcraftBlueprint(blueprint) : target(),
      ),
    nodes: {
      record: ({ context }) => {
        observed = context["start"];
        return Promise.resolve(null);
      },
    },
  });
  expect(
    (
      await engine.start({
        blueprintId: "selection",
        commit: "commit-a",
        context: { issue },
      })
    ).status,
  ).toBe("completed");
  expect(observed).toMatchObject({
    started: true,
    payload: { runId: expect.any(String) as unknown },
  });
});

it("binds a replayed lifecycle identity to its original source visit", async () => {
  const { store, start } = harness();
  const run = await start();
  const lifecycleId = store.lifecycleStarts()[0]?.lifecycleRunId ?? "missing";
  const context = {
    run,
    nodeId: "start",
    visit: 1,
    effectKey: lifecycleId,
    input: undefined,
    params: { blueprint: "collection" },
    context: { issue },
    await: () => Promise.resolve(),
  };
  const resolve = () => {
    throw new Error("Replay must use persisted blueprint");
  };
  expect(await lifecycleStart(store, resolve, context)).toEqual({
    started: true,
    payload: { runId: lifecycleId },
  });
  expect(store.lifecycleOrigin(lifecycleId)).toEqual({
    runId: run.id,
    nodeId: "start",
    visit: 1,
  });
  expect(store.lifecycleOrigin(run.id)).toBeUndefined();
  await expect(
    lifecycleStart(store, resolve, { ...context, visit: 2 }),
  ).rejects.toThrow("different invocation");
  await expect(
    lifecycleStart(store, resolve, {
      ...context,
      params: { blueprint: "collection", inputs: { changed: true } },
    }),
  ).rejects.toThrow("different invocation");
  expect(store.lifecycleStarts()).toHaveLength(1);
});

it("keeps an awaiting lifecycle untouched when recovering its completed intake", async () => {
  const { start, engine, store } = harness();
  const run = await start();
  const id = store.lifecycleStarts(run.id)[0]?.lifecycleRunId ?? "missing";
  const before = store.get(id);
  const events = store.events(id);
  await engine.recover();
  expect(store.get(id)).toEqual(before);
  expect(store.events(id)).toEqual(events);
});

it("dispatches a lifecycle after the intake result checkpoint commits", async () => {
  const blueprint = target();
  blueprint.nodes.splice(0, blueprint.nodes.length, {
    id: "inspect",
    uses: "inspect",
  });
  let sourceStatus: unknown;
  let sourceOutput: unknown;
  const { start, store } = harness({
    blueprint,
    nodes: {
      inspect: () => {
        const source = store.get("intake-1");
        sourceStatus = source.status;
        sourceOutput = source.context["start"];
        return Promise.resolve(null);
      },
    },
  });
  await start();
  expect(sourceStatus).toBe("completed");
  expect(sourceOutput).toEqual({
    started: true,
    payload: { runId: JSON.stringify(["intake-1", "start", 1]) },
  });
});
