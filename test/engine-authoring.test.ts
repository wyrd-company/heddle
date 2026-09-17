// ---
// relationships:
//   verifies:
//     - engine-and-run-model
//     - blueprint-authoring
// ---
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  deriveFlowcraftBlueprint,
  loadValidatedBlueprint,
  RunStore,
  WorkflowEngine,
} from "../src/index.js";

it("executes validated authored child runs through the public engine exports", async () => {
  const directory = mkdtempSync(join(tmpdir(), "heddle-engine-authoring-"));
  const store = new RunStore(join(directory, "runs.sqlite"));
  try {
    writeFileSync(
      join(directory, "collection.yml"),
      `
id: collection
kind: process
nodes:
  first:
    uses: child-run
    params:
      blueprint: inspection
      inputs: { item: { from: issue } }
  second:
    uses: child-run
    params:
      blueprint: inspection
      inputs: { item: { from: first.payload.result } }
      outputs: { answer: result }
  finish:
    uses: notify
    params:
      channel: pushover
      title: { inline: Complete }
edges:
  - { from: first, to: second, when: result.output.completed or result.output.failed }
  - { from: second, to: finish, when: result.output.completed or result.output.failed }
`,
    );
    writeFileSync(
      join(directory, "inspection.yml"),
      `
id: inspection
kind: stage
inputs: { item: {} }
outputs: { result: { type: string } }
nodes:
  inspect:
    uses: pass
    params:
      prompt: { inline: Inspect the item. }
      handoff:
        type: object
        description: Submit the inspection.
        properties: { value: { type: string } }
  finish:
    uses: notify
    params:
      channel: pushover
      title: { inline: Complete }
edges:
  - from: inspect
    to: finish
    when: result.output.handoff or result.output.overridden or result.output.turnEnded
`,
    );
    const resolutions: string[] = [];
    const engine = new WorkflowEngine(store, {
      resolveBlueprint: (commit, id) => {
        resolutions.push(commit);
        return Promise.resolve(
          deriveFlowcraftBlueprint(
            loadValidatedBlueprint(join(directory, `${id}.yml`)).blueprint,
          ),
        );
      },
      nodes: {
        pass: async ({ await: pause }) => {
          await pause({ kind: "pass" });
        },
        notify: ({ context }) => {
          context["result"] = "accepted";
          return Promise.resolve(null);
        },
      },
    });
    const run = await engine.start({
      id: "collection-1",
      blueprintId: "collection",
      commit: "commit-a",
      context: { issue: { item: "book" } },
    });
    for (const nodeId of ["first", "second"]) {
      const awaiting = store.awaiting(run.id)[0];
      expect(awaiting?.nodeId).toBe(nodeId);
      const childId = awaiting?.details.childRunId ?? "";
      expect(store.get(childId).initialContext).toEqual({
        item: nodeId === "first" ? { item: "book" } : "accepted",
      });
      await engine.resume({
        runId: childId,
        nodeId: "inspect",
        result: "handoff",
      });
    }
    const completed = store.get(run.id);
    expect(completed.status).toBe("completed");
    expect(completed.context["first"]).toMatchObject({
      payload: { result: "accepted" },
    });
    expect(completed.context["second"]).toMatchObject({
      payload: { answer: "accepted" },
    });
    expect(resolutions).toEqual(["commit-a", "commit-a", "commit-a"]);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
