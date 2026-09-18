// ---
// relationships:
//   verifies:
//     - blueprint-authoring
//     - engine-and-run-model
// ---
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  deriveFlowcraftBlueprint,
  loadValidatedBlueprint,
  RunStore,
  WorkflowEngine,
} from "../src/index.js";
import { passFixture } from "./support/pass-fixture.js";

const parcels = resolve("test/fixtures/blueprints/parcel-routing");
const catalog = resolve("fixtures/blueprints/collection-catalog");
const parcel = (id: string) =>
  deriveFlowcraftBlueprint(
    loadValidatedBlueprint(join(parcels, `${id}.yml`)).blueprint,
  );

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "blueprint-metadata-"));
  cleanups.push(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return join(directory, "runs.sqlite");
}
function open(path: string) {
  const store = new RunStore(path);
  cleanups.push(() => {
    store.close();
  });
  const engine = new WorkflowEngine(store, {
    resolveBlueprint: (_commit, id) => Promise.resolve(parcel(id)),
  });
  return { store, engine };
}

it.each([
  { attempts: 1, value: "delivered" },
  { attempts: 5, value: "held" },
])(
  "routes on the blueprint metadata guard with $attempts attempts",
  async ({ attempts, value }) => {
    const { store, engine } = open(workspace());
    const run = await engine.start({
      id: `parcel-${String(attempts)}`,
      blueprintId: "parcel-routing",
      commit: "pinned",
      context: { issue: { id: "item-1", fields: { Attempts: attempts } } },
    });
    expect(store.get(run.id).status).toBe("completed");
    expect(store.get(run.id).context["result"]).toBe(value);
  },
);

it("gives a child run its own metadata bag", async () => {
  const { store, engine } = open(workspace());
  const run = await engine.start({
    id: "parcel-child",
    blueprintId: "parcel-routing",
    commit: "pinned",
    context: { issue: { id: "item-1", fields: { Attempts: 1 } } },
  });
  const child = store
    .list()
    .map((listed) => store.get(listed.id))
    .find((candidate) => candidate.parentId === run.id);
  expect(child?.blueprintId).toBe("stage-weigh-parcel");
  expect(child?.context["result"]).toEqual({
    depot: "north-depot",
    attempts: 1,
    scale: "platform-scale",
  });
  expect(Object.keys(child?.context["result"] as object)).not.toContain(
    "maxAttempts",
  );
});

it("keeps the metadata bag readable across a store reopen", async () => {
  const path = workspace();
  const first = open(path);
  const run = await first.engine.start({
    id: "parcel-shelf",
    blueprintId: "parcel-hold",
    commit: "pinned",
    context: { issue: { id: "item-1" } },
  });
  const awaiting = first.store.awaiting(run.id)[0];
  expect(awaiting?.nodeId).toBe("hold");
  first.store.close();

  const second = open(path);
  await second.engine.resume({
    runId: run.id,
    nodeId: "hold",
    visit: 1,
    result: "released",
  });
  expect(second.store.get(run.id).status).toBe("completed");
  expect(second.store.get(run.id).context["result"]).toBe("cold-store");
});

it("renders a pass prompt with the running blueprint metadata", async () => {
  const stage = deriveFlowcraftBlueprint(
    loadValidatedBlueprint(join(catalog, "stage-assess-collection.yml"))
      .blueprint,
  );
  const fixture = passFixture(stage, {
    readArtifact: (_commit, _id, path) =>
      Promise.resolve(readFileSync(join(catalog, path), "utf8")),
  });
  await fixture.engine.start({
    id: "assessment",
    blueprintId: stage.id,
    commit: "pinned",
    context: { summary: "Twelve items, boxed" },
  });
  const started = fixture.commands.find(
    (command) => command.type === "thread.turn.start",
  );
  expect(started?.type === "thread.turn.start" && started.message.text).toEqual(
    expect.stringContaining("This stage is marked real-t3-code-pass."),
  );
});
