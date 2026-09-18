// ---
// relationships:
//   verifies:
//     - blueprint-authoring
//     - node-types
// ---
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import jsonata from "jsonata";
import { parse } from "yaml";
import { resolveValues } from "../src/engine/runtime.js";
import { afterEach, expect, it } from "vitest";
import {
  deriveFlowcraftBlueprint,
  loadValidatedBlueprint,
  RunStore,
  WorkflowEngine,
} from "../src/index.js";

const fixtureDirectory = resolve("fixtures/blueprints/collection-catalog");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function createHarness() {
  const directory = mkdtempSync(join(tmpdir(), "heddle-first-slice-"));
  temporaryDirectories.push(directory);
  const store = new RunStore(join(directory, "runs.sqlite"));
  const notifications: { blueprintId: string; nodeId: string }[] = [];
  const engine = new WorkflowEngine(store, {
    resolveBlueprint: (_commit, id) =>
      Promise.resolve(
        deriveFlowcraftBlueprint(
          loadValidatedBlueprint(join(fixtureDirectory, `${id}.yml`)).blueprint,
        ),
      ),
    nodes: {
      "on-issue-change": async ({ await: pause }) => {
        await pause({ kind: "issue-change" });
      },
      pass: async ({ await: pause }) => {
        await pause({ kind: "pass" });
      },
      policy: async ({ params }) => {
        const policy = parse(
          readFileSync(join(fixtureDirectory, String(params["rules"])), "utf8"),
        ) as {
          rules: {
            id: string;
            when?: string;
            blueprint: string;
            inputs?: Record<string, unknown>;
          }[];
        };
        const input = params["input"] as Record<string, unknown>;
        for (const rule of policy.rules) {
          if (
            rule.when === undefined ||
            (await jsonata(rule.when).evaluate(input))
          )
            return {
              matched: true,
              id: rule.id,
              blueprint: rule.blueprint,
              inputs: await resolveValues(rule.inputs ?? {}, input),
            };
        }
        return { matched: false };
      },
      notify: ({ run, nodeId }) => {
        notifications.push({ blueprintId: run.blueprintId, nodeId });
        return Promise.resolve(null);
      },
    },
  });
  return { engine, notifications, store };
}

it("re-classifies the changed issue snapshot in the same intake run", async () => {
  const { engine, store } = createHarness();
  try {
    const run = await engine.start({
      id: "intake-hold",
      blueprintId: "collection-intake",
      commit: "commit-a",
      context: { issue: { id: "item-1", type: "Unsorted" } },
    });
    expect(store.awaiting(run.id).map((item) => item.nodeId)).toEqual([
      "hold-for-match",
    ]);

    // The binding refreshes the run's issue before it resumes the wait.
    const changed = { id: "item-1", type: "Collection request" };
    const context = { ...store.get(run.id).context, issue: changed };
    store.save(run.id, context, {
      ...store.get(run.id).checkpoint,
      context,
    });
    await engine.resume({
      runId: run.id,
      nodeId: "hold-for-match",
      result: "changed",
      payload: changed,
    });

    const links = store.lifecycleStarts(run.id);
    expect(links).toHaveLength(1);
    expect(
      store.get(links[0]?.lifecycleRunId ?? "missing").initialContext,
    ).toEqual({ issue: changed });
    expect(store.get(run.id).status).toBe("completed");
  } finally {
    store.close();
  }
});

it.each([
  {
    result: "handoff",
    payload: { decision: "accepted", reason: "Complete" },
    terminal: "record",
  },
  {
    result: "overridden",
    payload: undefined,
    terminal: "assessment-incomplete",
  },
  {
    result: "turnEnded",
    payload: undefined,
    terminal: "assessment-incomplete",
  },
] as const)(
  "routes an assessment $result through the mapped child output",
  async ({ payload, result, terminal }) => {
    const { engine, notifications, store } = createHarness();
    try {
      const run = await engine.start({
        id: `catalog-${result}`,
        blueprintId: "collection-catalog",
        commit: "commit-a",
        context: {
          issue: {
            fields: { "Item Count": 3 },
            frontMatter: { storage: "box" },
          },
        },
      });
      const captureId = String(store.awaiting(run.id)[0]?.details.childRunId);
      const summary = { itemCount: 3, storage: "box" };
      await engine.resume({
        runId: captureId,
        nodeId: "capture",
        result: "handoff",
        payload: summary,
      });

      const assessId = String(store.awaiting(run.id)[0]?.details.childRunId);
      expect(store.get(assessId).initialContext).toEqual({ summary });
      await engine.resume({
        runId: assessId,
        nodeId: "assess",
        result,
        ...(payload === undefined ? {} : { payload }),
      });

      expect(store.get(run.id).status).toBe("completed");
      expect(
        notifications.filter((item) => item.blueprintId.startsWith("stage-")),
      ).toEqual([]);
      expect(store.get(assessId).context["result"]).toEqual({
        [result]: true,
        payload: payload ?? null,
      });
      expect(notifications).toContainEqual({
        blueprintId: "collection-catalog",
        nodeId: terminal,
      });
    } finally {
      store.close();
    }
  },
);

it("starts the fixture policy-selected lifecycle without awaiting its completion", async () => {
  const { engine, store, notifications } = createHarness();
  try {
    const issue = {
      id: "item-1",
      type: "Collection request",
      fields: { "Item Count": 3 },
    };
    const intake = await engine.start({
      id: "intake-1",
      blueprintId: "collection-intake",
      commit: "commit-a",
      context: { issue },
    });
    expect(intake.status).toBe("completed");
    const links = store.lifecycleStarts(intake.id);
    expect(links).toHaveLength(1);
    const lifecycle = store.get(links[0]?.lifecycleRunId ?? "missing");
    expect(lifecycle).toMatchObject({
      blueprintId: "collection-catalog",
      parentId: null,
      rootId: lifecycle.id,
      status: "awaiting",
      initialContext: { issue },
    });
    expect(store.awaiting(intake.id)).toEqual([]);
    expect(notifications).toEqual([]);
  } finally {
    store.close();
  }
});

it("holds until expiry, sends intended attention, and waits untimed", async () => {
  const { engine, store, notifications } = createHarness();
  try {
    const run = await engine.start({
      blueprintId: "collection-intake",
      commit: "commit-a",
      context: { issue: { id: "item-1", type: "Unsorted" } },
    });
    await engine.resume({
      runId: run.id,
      nodeId: "hold-for-match",
      result: "timeout",
    });
    expect(store.get(run.id).status).toBe("awaiting");
    expect(store.awaiting(run.id).map((item) => item.nodeId)).toEqual([
      "wait-for-match",
    ]);
    expect(notifications).toEqual([
      { blueprintId: "collection-intake", nodeId: "notify-attention" },
    ]);
  } finally {
    store.close();
  }
});

it("the parallel appraisal fixture returns named answers without notifications", async () => {
  const directory = mkdtempSync(join(tmpdir(), "heddle-appraisal-"));
  temporaryDirectories.push(directory);
  const store = new RunStore(join(directory, "runs.sqlite"));
  try {
    const engine = new WorkflowEngine(store, {
      resolveBlueprint: () =>
        Promise.resolve(
          deriveFlowcraftBlueprint(
            loadValidatedBlueprint(
              resolve(
                "fixtures/blueprints/parallel-appraisal/parallel-appraisal.yml",
              ),
            ).blueprint,
          ),
        ),
    });
    const run = await engine.start({
      blueprintId: "parallel-appraisal",
      commit: "commit-a",
    });
    await engine.resume({
      runId: run.id,
      nodeId: "inspect-history",
      result: "answered",
      payload: { history: "sufficient" },
    });
    expect(store.get(run.id).status).toBe("awaiting");
    await engine.resume({
      runId: run.id,
      nodeId: "inspect-condition",
      result: "answered",
      payload: { condition: "stable" },
    });
    expect(store.get(run.id)).toMatchObject({
      status: "completed",
      context: {
        result: {
          condition: { condition: "stable" },
          history: { history: "sufficient" },
        },
      },
    });
  } finally {
    store.close();
  }
});
