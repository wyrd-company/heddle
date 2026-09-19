// ---
// relationships:
//   verifies:
//     - agent-tools
//     - github-binding-and-intake
// ---
import { expect, it } from "vitest";
import {
  RunStore,
  GitHubBindingService,
  deriveFlowcraftBlueprint,
  GeneratedToolService,
  prepareAgentTools,
  type Blueprint,
  type ToolBinding,
} from "../src/index.js";
import { fixture } from "./binding.fixture.js";

it("projects each cyclic pass visit before dispatch and preserves the configured stage hook", async () => {
  const wire = fixture();
  const store = new RunStore(":memory:");
  const bindings: ToolBinding[] = [];
  const visits: [string, number][] = [];
  const statuses: unknown[] = [];
  const blueprint: Blueprint = {
    id: "cook",
    kind: "process",
    entry: "prepare",
    nodes: {
      prepare: { uses: "pass", stage: true },
      count: { uses: "count", stage: true },
      finish: { uses: "done", stage: true },
    },
    edges: [
      { from: "prepare", to: "count", when: "result.output.turnEnded" },
      { from: "count", to: "prepare", when: "attempts < 2" },
      { from: "count", to: "finish", when: "attempts >= 2" },
    ],
  };
  const binding = new GitHubBindingService(
    store,
    [{ owner: "sample-owner", number: 1 }],
    wire.clients,
    () => Promise.resolve([blueprint]),
    {
      resolveBlueprint: () =>
        Promise.resolve(deriveFlowcraftBlueprint(blueprint)),
      beforeNode: (context) => {
        visits.push([context.nodeId, context.visit]);
        return Promise.resolve();
      },
      nodes: {
        pass: async (context) => {
          statuses.push(wire.values["C_1"]?.["Status"]);
          const prepared = prepareAgentTools({
            threadId: `thread-${String(context.visit)}`,
            handoff: { type: "object", description: "Submit the recipe." },
            context: context.context,
          });
          bindings.push(prepared.binding);
          await context.await(prepared.details);
        },
        count: ({ context }) => {
          statuses.push(wire.values["C_1"]?.["Status"]);
          context["attempts"] = Number(context["attempts"] ?? 0) + 1;
          return Promise.resolve();
        },
        done: () => {
          statuses.push(wire.values["C_1"]?.["Status"]);
          return Promise.resolve();
        },
      },
    },
  );
  try {
    await binding.start();
    const run = await binding.startInstance("I_1", "cook", "snapshot-a");
    const tools = new GeneratedToolService(binding.engine);
    for (let index = 0; index < 2; index++) {
      const current = bindings[index];
      expect(current).toBeDefined();
      if (!current) throw new Error("Missing pass binding");
      await tools.observeTurnEnd(current.path);
      tools.recover();
    }
    expect(bindings).toHaveLength(2);
    expect(visits).toEqual([
      ["prepare", 1],
      ["count", 1],
      ["prepare", 2],
      ["count", 2],
      ["finish", 1],
    ]);
    expect(statuses).toEqual([
      "prepare",
      "count",
      "prepare",
      "count",
      "finish",
    ]);
    expect(store.get(run.id)).toMatchObject({
      status: "completed",
      context: { attempts: 2 },
    });
    expect(binding.instances.get("I_1").issue.project.fields["Status"]).toBe(
      "finish",
    );
  } finally {
    store.close();
  }
});
