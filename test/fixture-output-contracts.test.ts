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

it.each(
  [
    {
      blueprintId: "stage-capture-collection",
      nodeId: "capture",
      handoff: { itemCount: 3, storage: "box" },
    },
    {
      blueprintId: "stage-assess-collection",
      nodeId: "assess",
      handoff: { decision: "accepted", reason: "Complete" },
    },
  ].flatMap((stage) =>
    ["handoff", "overridden", "turnEnded"].map((result) => ({
      ...stage,
      result,
    })),
  ),
)(
  "declared collection output accepts $blueprintId $result completion",
  async ({ blueprintId, nodeId, handoff, result }) => {
    const temporary = mkdtempSync(join(tmpdir(), "stage-contract-"));
    const store = new RunStore(join(temporary, "runs.sqlite"));
    try {
      const blueprint = loadValidatedBlueprint(
        resolve("fixtures/blueprints/collection-catalog", `${blueprintId}.yml`),
      ).blueprint;
      const engine = new WorkflowEngine(store, {
        resolveBlueprint: () =>
          Promise.resolve(deriveFlowcraftBlueprint(blueprint)),
        nodes: {
          pass: async ({ await: pause }) => {
            await pause({ kind: "pass" });
          },
        },
      });
      const run = await engine.start({
        id: "sample-a",
        blueprintId,
        commit: "revision-a",
      });
      await engine.resume({
        runId: run.id,
        nodeId,
        result,
        ...(result === "handoff" ? { payload: handoff } : {}),
      });
      const final = store.get(run.id);
      expect(final.status).toBe("completed");
      const schema = blueprint.outputs?.["result"];
      if (schema === undefined) throw new Error("Missing declared output");
      const validate = new Ajv2020({ strict: false }).compile(schema);
      expect(
        validate(final.context["result"]),
        JSON.stringify(validate.errors),
      ).toBe(true);
    } finally {
      store.close();
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);
