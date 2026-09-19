// ---
// relationships:
//   verifies: engine-and-run-model
// ---
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import {
  deriveFlowcraftBlueprint,
  loadValidatedBlueprint,
  RunStore,
  WorkflowEngine,
} from "../src/index.js";
import type { Data } from "../src/engine/index.js";

const directory = resolve("fixtures/blueprints/recipe-pipeline");
const load = (id: string) =>
  loadValidatedBlueprint(join(directory, `${id}.yml`)).blueprint;

const maxTasteTests = 3;
const startContext = {
  issue: { fields: { Servings: 2 } },
  blueprint: { metadata: { maxTasteTests } },
};

function build(store: RunStore, effects: string[]): WorkflowEngine {
  return new WorkflowEngine(store, {
    resolveBlueprint: (_commit, id) =>
      Promise.resolve(deriveFlowcraftBlueprint(load(id))),
    nodes: {
      pass: async ({ await: pause }) => {
        await pause({ kind: "pass" });
      },
      notify: ({ nodeId }) => {
        effects.push(nodeId);
        return Promise.resolve(null);
      },
      github: ({ nodeId }) => {
        effects.push(nodeId);
        return Promise.resolve(null);
      },
    },
  });
}

const childOf = (store: RunStore, runId: string) =>
  String(store.awaiting(runId)[0]?.details.childRunId);

const draft = { title: "Soup", ingredients: ["water"], steps: ["Heat"] };

async function reachTasteTest(
  engine: WorkflowEngine,
  store: RunStore,
  runId: string,
): Promise<string> {
  await engine.resume({
    runId: childOf(store, runId),
    nodeId: "prepare",
    result: "handoff",
    payload: draft,
  });
  return childOf(store, runId);
}

const visits = (store: RunStore, runId: string, nodeId: string) => {
  const stages = store.get(runId).context["stages"] as Data | undefined;
  return (stages?.[nodeId] as Data | undefined)?.["visits"];
};

it("routes a rejected taste test back to the draft stage", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "stage-visits-"));
  const store = new RunStore(join(temporary, "runs.sqlite"));
  const effects: string[] = [];
  try {
    const engine = build(store, effects);
    const run = await engine.start({
      id: "recipe-loop",
      blueprintId: "recipe-pipeline",
      commit: "revision-a",
      context: startContext,
    });
    for (let attempt = 1; attempt <= maxTasteTests; attempt += 1) {
      const child = await reachTasteTest(engine, store, run.id);
      expect(visits(store, run.id, "taste-test")).toBe(attempt);
      await engine.resume({
        runId: child,
        nodeId: "prepare",
        result: "handoff",
        payload: { verdict: "rejected", notes: "Bland" },
      });
    }
    expect(effects).toEqual(["too-many-tests"]);
    expect(visits(store, run.id, "draft")).toBe(maxTasteTests);
    expect(store.get(run.id).status).toBe("completed");
  } finally {
    store.close();
    rmSync(temporary, { recursive: true, force: true });
  }
});

it("keeps stage visits across a store reopen", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "stage-visits-reopen-"));
  const path = join(temporary, "runs.sqlite");
  const effects: string[] = [];
  let store = new RunStore(path);
  try {
    const engine = build(store, effects);
    const run = await engine.start({
      id: "recipe-reopen",
      blueprintId: "recipe-pipeline",
      commit: "revision-a",
      context: startContext,
    });
    const child = await reachTasteTest(engine, store, run.id);
    store.close();
    store = new RunStore(path);
    const reopened = build(store, effects);
    expect(visits(store, run.id, "taste-test")).toBe(1);
    await reopened.resume({
      runId: child,
      nodeId: "prepare",
      result: "handoff",
      payload: { verdict: "rejected", notes: "Bland" },
    });
    expect(visits(store, run.id, "draft")).toBe(2);
    expect(effects).toEqual([]);
  } finally {
    store.close();
    rmSync(temporary, { recursive: true, force: true });
  }
});
