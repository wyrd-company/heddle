// ---
// relationships:
//   verifies:
//     - blueprint-authoring
//     - node-types
// ---
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { expect, it } from "vitest";
import {
  validateBlueprintFile,
  deriveFlowcraftBlueprint,
} from "../src/index.js";
import type { Blueprint } from "../src/blueprints/types.js";
import { validateNodeParams } from "../src/blueprints/schema-validation.js";
import { RunStore, WorkflowEngine } from "../src/engine/index.js";
import { aggregate, terminalResult } from "../src/engine/result-nodes.js";
import type { EngineNodeContext } from "../src/engine/types.js";

const valid: Blueprint = {
  id: "parcel",
  kind: "helper",
  nodes: {
    left: { uses: "wait" },
    right: { uses: "wait" },
    combine: {
      uses: "aggregate",
      params: {
        bindings: {
          first: { node: "left" },
          second: { node: "right", path: "payload" },
        },
      },
    },
    finish: { uses: "terminal-result", params: { value: { from: "combine" } } },
  },
  edges: [
    { from: "left", to: "combine" },
    { from: "right", to: "combine" },
    { from: "combine", to: "finish" },
  ],
};

it.each([
  ["terminal-result", undefined],
  ["terminal-result", {}],
  ["terminal-result", { value: { from: "x", extra: 1 } }],
  ["terminal-result", { value: 1, extra: true }],
  ["aggregate", {}],
  ["aggregate", { bindings: { first: { node: "left" } }, extra: true }],
  ["aggregate", { bindings: [] }],
  ["aggregate", { bindings: { first: {} } }],
  ["aggregate", { bindings: { first: { node: "left", path: 1 } } }],
  ["aggregate", { bindings: {} }],
  ["aggregate", { bindings: { first: "left" } }],
  ["aggregate", { bindings: { first: { node: "left", path: "" } } }],
  ["aggregate", { bindings: { first: { node: "left", extra: true } } }],
])("rejects malformed %s params %j", (type, params) => {
  expect(validateNodeParams(type, params).valid).toBe(false);
});

interface MutableFixture {
  nodes: Record<
    string,
    {
      uses: string;
      params?: Record<string, unknown>;
      config?: { joinStrategy: "all" | "any" };
    }
  >;
  edges: { from: string; to: string }[];
}
function getCombine(value: MutableFixture) {
  return value.nodes["combine"] as {
    uses: string;
    params: { bindings: Record<string, { node: string; path?: string }> };
    config?: { joinStrategy: "all" | "any" };
  };
}
function getSecond(value: MutableFixture) {
  return getCombine(value).params.bindings["second"] as {
    node: string;
    path?: string;
  };
}
const cases: [string, (value: MutableFixture) => void, string][] = [
  [
    "invalid terminal expression",
    (value) => {
      value.nodes["finish"] = {
        uses: "terminal-result",
        params: { value: { nested: [{ from: "(" }] } },
      };
    },
    "invalid JSONata reference",
  ],
  [
    "missing terminal params",
    (value) => {
      value.nodes["finish"] = { uses: "terminal-result" };
    },
    "Invalid terminal-result parameters",
  ],

  [
    "missing predecessor",
    (value) => {
      delete getCombine(value).params.bindings["second"];
    },
    "no aggregate binding",
  ],
  [
    "duplicate predecessor",
    (value) => {
      getSecond(value).node = "left";
    },
    "more than once",
  ],
  [
    "unknown predecessor",
    (value) => {
      getSecond(value).node = "absent";
    },
    "direct predecessor",
  ],
  [
    "nonincoming predecessor",
    (value) => {
      getSecond(value).node = "finish";
    },
    "direct predecessor",
  ],
  [
    "any join",
    (value) => {
      getCombine(value).config = { joinStrategy: "any" };
    },
    "all join",
  ],
  [
    "invalid binding expression",
    (value) => {
      getSecond(value).path = "(";
    },
    "invalid JSONata",
  ],
  [
    "terminal outgoing edge",
    (value) => {
      value.edges.push({ from: "finish", to: "left" });
    },
    "outgoing edges",
  ],
];
it.each(cases)(
  "rejects %s during authoring and before engine creates a run",
  async (_name, mutate, message) => {
    const blueprint = structuredClone(valid);
    mutate(blueprint as unknown as MutableFixture);
    const directory = mkdtempSync(join(tmpdir(), "heddle-contract-"));
    const store = new RunStore(join(directory, "runs.sqlite"));
    try {
      const file = join(directory, "parcel.yml");
      writeFileSync(file, stringify(blueprint));
      expect(
        validateBlueprintFile(file).some(
          (finding) =>
            finding.rule === "heddle.result-contract" &&
            finding.message.includes(message),
        ),
      ).toBe(true);
      const engine = new WorkflowEngine(store, {
        resolveBlueprint: () =>
          Promise.resolve(deriveFlowcraftBlueprint(blueprint)),
      });
      await expect(
        engine.start({ blueprintId: "parcel", commit: "commit-a" }),
      ).rejects.toThrow(message);
      expect(store.list()).toEqual([]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("rejects an incomplete predecessor even if context contains its earlier value", async () => {
  const context = {
    params: { bindings: { first: { node: "left" } } },
    context: { left: "stale" },
  } as unknown as EngineNodeContext;
  await expect(aggregate(context)).rejects.toThrow("incomplete");
});

it.each([null, false, 7, ["parcel"], { status: "ready" }])(
  "returns complete predecessor value %j without a path",
  async (value) => {
    const context = {
      params: { bindings: { first: { node: "left" } } },
      context: { left: value, "_outputs.left": value },
    } as unknown as EngineNodeContext;
    await expect(aggregate(context)).resolves.toEqual({ first: value });
  },
);

it("reads aggregate data from the completed output rather than a mutable context alias", async () => {
  const context = {
    params: { bindings: { first: { node: "left" } } },
    context: { left: "edited alias", "_outputs.left": "completed output" },
  } as unknown as EngineNodeContext;
  await expect(aggregate(context)).resolves.toEqual({
    first: "completed output",
  });
});

it("terminal execution writes its value before settlement", async () => {
  const context = {
    nodeId: "finish",
    params: { value: { grade: "stable" } },
    context: {},
  } as unknown as EngineNodeContext;
  await expect(terminalResult(context)).resolves.toEqual({ grade: "stable" });
  expect(context.context["result"]).toEqual({ grade: "stable" });
});
