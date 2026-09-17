// ---
// relationships:
//   verifies: blueprint-authoring
// ---
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import {
  deriveFlowcraftBlueprint,
  loadValidatedBlueprint,
  RunStore,
  WorkflowEngine,
} from "../src/index.js";

const directory = resolve("fixtures/blueprints/recipe-pipeline");
const load = (id: string) =>
  loadValidatedBlueprint(join(directory, `${id}.yml`)).blueprint;

it.each([
  { stage: "draft", result: "overridden" },
  { stage: "draft", result: "turnEnded" },
  { stage: "taste-test", result: "overridden" },
  { stage: "taste-test", result: "turnEnded" },
  { stage: "taste-test", result: "handoff" },
])(
  "executes the recipe child declarations for $stage $result",
  async ({ stage, result }) => {
    const temporary = mkdtempSync(join(tmpdir(), "recipe-contract-"));
    const store = new RunStore(join(temporary, "runs.sqlite"));
    const effects: string[] = [];
    try {
      const engine = new WorkflowEngine(store, {
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
      const run = await engine.start({
        id: "recipe-a",
        blueprintId: "recipe-pipeline",
        commit: "revision-a",
        context: { issue: { fields: { Servings: 2 } } },
      });
      let childId = String(store.awaiting(run.id)[0]?.details.childRunId);
      if (stage === "taste-test") {
        await engine.resume({
          runId: childId,
          nodeId: "prepare",
          result: "handoff",
          payload: { title: "Soup", ingredients: ["water"], steps: ["Heat"] },
        });
        childId = String(store.awaiting(run.id)[0]?.details.childRunId);
      }
      await engine.resume({
        runId: childId,
        nodeId: "prepare",
        result,
        ...(result === "handoff"
          ? { payload: { verdict: "approved", notes: "Ready" } }
          : {}),
      });
      expect(store.get(run.id).status).toBe("completed");
      expect(effects).toEqual([
        result === "handoff" ? "publish" : "run-failed",
      ]);
      for (const child of store
        .list()
        .filter((item) => item.parentId === run.id)) {
        const contract = load(child.blueprintId).outputs?.["result"];
        if (contract === undefined)
          throw new Error("Missing fixture output contract");
        const validate = new Ajv2020({ strict: false }).compile(contract);
        expect(
          validate(child.context["result"]),
          JSON.stringify(validate.errors),
        ).toBe(true);
      }
    } finally {
      store.close();
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);
