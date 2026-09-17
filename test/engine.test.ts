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
