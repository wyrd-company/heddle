// ---
// relationships:
//   verifies: github-binding-and-intake
// ---
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../src/engine/store.js";
import { GitHubBindingService } from "../src/binding/service.js";
import { deriveFlowcraftBlueprint } from "../src/blueprints/flowcraft.js";
import type { Blueprint } from "../src/blueprints/types.js";
import { githubEffect } from "../src/binding/effects.js";
import type { Data, Run } from "../src/engine/types.js";
import { fixture } from "./binding.fixture.js";

const dirs: string[] = [];
const stores: RunStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const hold: Blueprint[] = [
  { id: "cook", kind: "process", nodes: { prepare: { uses: "wait" } } },
];

function setup(blueprints: Blueprint[] = hold) {
  const wire = fixture();
  const dir = mkdtempSync(join(tmpdir(), "operations-"));
  dirs.push(dir);
  const store = new RunStore(join(dir, "state.db"));
  stores.push(store);
  const service = new GitHubBindingService(
    store,
    [{ owner: "sample-owner", number: 1 }],
    wire.clients,
    () => Promise.resolve(blueprints),
    {
      resolveBlueprint: (_commit, id) => {
        const found = blueprints.find((b) => b.id === id);
        if (!found) throw new Error("Missing fixture blueprint");
        return Promise.resolve(deriveFlowcraftBlueprint(found));
      },
    },
  );
  return { ...wire, store, service };
}

const started = new Map<ReturnType<typeof setup>, Run>();

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

const vegetarian = {
  id: "L_1",
  name: "vegetarian",
  color: "FFFFFF",
  description: null,
};

async function apply(
  f: ReturnType<typeof setup>,
  params: Data,
  effectKey = "effect-1",
) {
  let run = started.get(f);
  if (!run) {
    run = await f.service.startInstance("I_1", "cook", "revision");
    started.set(f, run);
  }
  const client = f.clients();
  const project = await client.owner("sample-owner").project(1).open();
  const context = {
    run,
    nodeId: "effect",
    visit: 1,
    effectKey,
    params,
    input: null,
    context: { issue: f.service.instances.get("I_1").issue } as Data,
    await: () => Promise.resolve(),
  };
  await githubEffect(context, project, client, f.service.instances);
  return { context, client, project };
}

it.each(["completed", "not-planned"] as const)(
  "closes the issue as %s and carries the new state into the run context",
  async (reason) => {
    const f = setup();
    await f.service.start();

    const { context } = await apply(f, { operation: "close", reason });

    expect(present(f.issues.at(0)).state).toBe("CLOSED");
    expect(f.transport.callsTo("CloseIssue")).toHaveLength(1);
    expect(context.context["issue"]).toMatchObject({
      state: "closed",
      stateReason: reason,
    });
    expect(f.service.instances.get("I_1").issue.state).toBe("closed");
  },
);

it("defaults a close without a reason to completed", async () => {
  const f = setup();
  await f.service.start();

  const { context } = await apply(f, { operation: "close" });

  expect(context.context["issue"]).toMatchObject({
    state: "closed",
    stateReason: "completed",
  });
});

it("does not close an issue already in the target closed state", async () => {
  const f = setup();
  await f.service.start();
  const issue = present(f.issues.at(0));
  issue.state = "CLOSED";
  issue.stateReason = "COMPLETED";

  const { context } = await apply(f, {
    operation: "close",
    reason: "completed",
  });

  expect(f.transport.callsTo("CloseIssue")).toHaveLength(0);
  expect(context.context["issue"]).toMatchObject({ state: "closed" });
});

it("reopens a closed issue and does nothing when it is already open", async () => {
  const f = setup();
  await f.service.start();
  const issue = present(f.issues.at(0));
  issue.state = "CLOSED";
  issue.stateReason = "COMPLETED";

  const { context } = await apply(f, { operation: "reopen" });

  expect(f.transport.callsTo("ReopenIssue")).toHaveLength(1);
  expect(context.context["issue"]).toMatchObject({ state: "open" });

  await apply(f, { operation: "reopen" }, "effect-2");

  expect(f.transport.callsTo("ReopenIssue")).toHaveLength(1);
});

it("does not deliver its own add-labels write back as an operator change", async () => {
  const f = setup();
  await f.service.start();

  await apply(f, { operation: "add-labels", labels: ["vegetarian"] });

  const issue = present(f.issues.at(0));
  expect(issue.labels.nodes.map((label) => label.name)).toEqual(["vegetarian"]);
  await expect(
    f.service.deliver("issues", {
      issue: { node_id: issue.id, updated_at: issue.updatedAt },
    }),
  ).resolves.toBe(false);
});

it("removes only the labels the issue carries", async () => {
  const f = setup();
  present(f.issues.at(0)).labels.nodes.push(vegetarian);
  await f.service.start();

  const { context } = await apply(f, {
    operation: "remove-labels",
    labels: ["vegetarian"],
  });

  expect(present(f.issues.at(0)).labels.nodes).toHaveLength(0);
  expect(f.transport.callsTo("RemoveLabelsFromLabelable")).toHaveLength(1);
  expect(context.context["issue"]).toMatchObject({ labels: [] });

  await apply(f, { operation: "remove-labels", labels: ["vegetarian"] }, "e-2");

  expect(f.transport.callsTo("RemoveLabelsFromLabelable")).toHaveLength(1);
});

it.each([
  { operation: "close", reason: "completed" },
  { operation: "reopen" },
  { operation: "remove-labels", labels: ["vegetarian"] },
])("replays $operation without applying it twice", async (params) => {
  const f = setup();
  const issue = present(f.issues.at(0));
  issue.labels.nodes.push(vegetarian);
  await f.service.start();
  if (params.operation === "reopen") {
    issue.state = "CLOSED";
    issue.stateReason = "COMPLETED";
  }

  const { context, client, project } = await apply(f, params);
  const calls = f.transport.calls.length;
  await githubEffect(context, project, client, f.service.instances);

  expect(f.transport.calls).toHaveLength(calls);
  await expect(
    githubEffect(
      { ...context, params: { ...params, extra: true } },
      project,
      client,
      f.service.instances,
    ),
  ).rejects.toThrow("identity reused");
});

it("completes a lifecycle that ends in a github close", async () => {
  const f = setup([
    {
      id: "cook",
      kind: "process",
      nodes: {
        finish: {
          uses: "github",
          params: { operation: "close", reason: "completed" },
        },
        done: { uses: "terminal-result", params: { value: "closed" } },
      },
      edges: [{ from: "finish", to: "done" }],
    },
  ]);
  await f.service.start();

  const run = await f.service.startInstance("I_1", "cook", "revision");

  expect(f.store.get(run.id).status).toBe("completed");
  expect(present(f.issues.at(0)).state).toBe("CLOSED");
  expect(f.service.instances.get("I_1").issue.stateReason).toBe("completed");
});

it("refuses an unsupported operation", async () => {
  const f = setup();
  await f.service.start();

  await expect(apply(f, { operation: "link" })).rejects.toThrow(
    "Unsupported GitHub operation: link",
  );
});
