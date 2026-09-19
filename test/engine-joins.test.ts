// ---
// relationships:
//   verifies: engine-and-run-model
// ---
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowBlueprint } from "flowcraft";
import { expect, it } from "vitest";
import { RunStore, WorkflowEngine, type Data } from "../src/engine/index.js";

it.each(["children", "pauses", "mixed"])(
  "an all join waits for every %s predecessor and sees both results",
  async (shape) => {
    const directory = mkdtempSync(join(tmpdir(), "heddle-joins-"));
    const store = new RunStore(join(directory, "runs.sqlite"));
    try {
      const observed: unknown[] = [];
      const blueprint: WorkflowBlueprint = {
        id: "shipment",
        nodes: [
          { id: "start", uses: "quick" },
          ...["left", "right"].map((id) => ({
            id,
            uses:
              shape === "children"
                ? "child-run"
                : shape === "mixed" && id === "right"
                  ? "quick"
                  : "pass",
            params: {
              blueprint: "inspection",
              outputs: { value: "work.payload.value" },
            },
          })),
          { id: "combine", uses: "combine", config: { joinStrategy: "all" } },
        ],
        edges: [
          ...["left", "right"].map((target) => ({ source: "start", target })),
          ...["left", "right"].map((source) => ({
            source,
            target: "combine",
            ...(shape === "mixed" && source === "right"
              ? {}
              : {
                  condition:
                    shape === "children"
                      ? "result.output.completed"
                      : "result.output.handoff",
                }),
          })),
        ],
      };
      const engine = new WorkflowEngine(store, {
        resolveBlueprint: (_commit, id) =>
          Promise.resolve(
            id === "shipment"
              ? blueprint
              : {
                  id: "inspection",
                  nodes: [{ id: "work", uses: "pass" }],
                  edges: [],
                },
          ),
        nodes: {
          quick: () => Promise.resolve("ready"),
          pass: async ({ await: pause }) => {
            await pause({ kind: "pass" });
          },
          combine: ({ context }) => {
            observed.push([context["left"], context["right"]]);
            return Promise.resolve(null);
          },
        },
      });
      const run = await engine.start({
        blueprintId: "shipment",
        commit: "commit-a",
      });
      expect(observed).toEqual([]);
      const pending = store.awaiting(run.id);
      for (const [index, item] of pending.entries()) {
        await engine.resume({
          runId:
            shape === "children" ? String(item.details.childRunId) : run.id,
          nodeId: shape === "children" ? "work" : item.nodeId,
          result: "handoff",
          payload: { value: index + 1 },
        });
        if (index < pending.length - 1) {
          expect(observed).toEqual([]);
          expect(store.get(run.id).status).toBe("awaiting");
        }
      }
      expect(observed).toHaveLength(1);
      const outputs = observed[0] as Data[];
      expect(outputs[0]).toMatchObject({ payload: { value: 1 } });
      if (shape === "mixed") expect(outputs[1]).toBe("ready");
      else expect(outputs[1]).toMatchObject({ payload: { value: 2 } });
      expect(store.get(run.id).status).toBe("completed");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it.each(["ordinary", "paused"])(
  "a revisited paused branch stays unfinished with %s sibling work",
  async (sibling) => {
    const directory = mkdtempSync(join(tmpdir(), "heddle-joins-"));
    const store = new RunStore(join(directory, "runs.sqlite"));
    try {
      let joins = 0;
      const blueprint: WorkflowBlueprint = {
        id: "shipment",
        nodes: [
          { id: "start", uses: "quick" },
          { id: "left", uses: "pass", config: { joinStrategy: "any" } },
          { id: "fork", uses: "quick" },
          { id: "right", uses: sibling === "ordinary" ? "quick" : "pass" },
          { id: "combine", uses: "combine", config: { joinStrategy: "all" } },
        ],
        edges: [
          { source: "start", target: "left" },
          {
            source: "left",
            target: "fork",
            condition: "result.output.payload.again",
          },
          {
            source: "left",
            target: "combine",
            condition: "$not(result.output.payload.again)",
          },
          { source: "fork", target: "left" },
          { source: "fork", target: "right" },
          { source: "right", target: "combine" },
        ],
      };
      const engine = new WorkflowEngine(store, {
        resolveBlueprint: () => Promise.resolve(blueprint),
        nodes: {
          quick: () => Promise.resolve(null),
          pass: async ({ await: pause }) => {
            await pause({ kind: "pass" });
          },
          combine: () => {
            joins++;
            return Promise.resolve(null);
          },
        },
      });
      const run = await engine.start({
        blueprintId: "shipment",
        commit: "commit-a",
      });
      await engine.resume({
        runId: run.id,
        nodeId: "left",
        result: "handoff",
        payload: { again: true },
      });
      expect(
        store.awaiting(run.id).find((row) => row.nodeId === "left")?.visit,
      ).toBe(2);
      expect(joins).toBe(0);
      if (sibling === "paused") {
        await engine.resume({
          runId: run.id,
          nodeId: "right",
          result: "handoff",
        });
        expect(joins).toBe(0);
      }
      await engine.resume({
        runId: run.id,
        nodeId: "left",
        result: "handoff",
        payload: { again: false },
      });
      expect(joins).toBe(1);
      expect(store.get(run.id).status).toBe("completed");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
