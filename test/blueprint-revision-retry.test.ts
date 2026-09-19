// ---
// relationships:
//   verifies: engine-and-run-model
// ---
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { BlueprintCatalog } from "../src/service/blueprints.js";
import { WorkflowEngine } from "../src/engine/engine.js";
import { RunStore } from "../src/engine/store.js";
import type { EngineNodeContext } from "../src/engine/types.js";
import { commitFixture, writeSample } from "./support/blueprint-repository.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("retains the original requested revision through persistence and reuses its snapshot on root retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "revision-retry-"));
  roots.push(root);
  writeSample(root, "first");
  const firstCommit = commitFixture(root);
  const path = join(root, "runs.sqlite");
  const original = new RunStore(path);
  const catalog = new BlueprintCatalog(root);
  const options = {
    pinCommit: (revision: string) => catalog.pin(revision),
    resolveBlueprint: (commit: string, id: string) =>
      catalog.resolve(commit, id),
    nodes: {
      pass: async (context: EngineNodeContext) => {
        await context.await({ kind: "pass" });
      },
    },
  };
  try {
    const first = await new WorkflowEngine(original, options).start({
      id: "parcel",
      blueprintId: "sample-process",
      commit: "HEAD",
    });
    expect(first.commit).toBe(firstCommit);
    expect(first.requestedRevision).toBe("HEAD");
    const row = original.db
      .prepare(
        "SELECT blueprint_commit, requested_revision FROM runs WHERE id=?",
      )
      .get(first.id);
    expect(row).toMatchObject({
      blueprint_commit: firstCommit,
      requested_revision: "HEAD",
    });
  } finally {
    original.close();
  }
  writeSample(root, "second");
  const secondCommit = commitFixture(root);
  const restored = new RunStore(path);
  const pin = vi.fn(options.pinCommit);
  const resolve = vi.fn(options.resolveBlueprint);
  const engine = new WorkflowEngine(restored, {
    ...options,
    pinCommit: pin,
    resolveBlueprint: resolve,
  });
  try {
    expect(restored.get("parcel").requestedRevision).toBe("HEAD");
    const retried = await engine.start({
      id: "parcel",
      blueprintId: "sample-process",
      commit: "HEAD",
    });
    expect(retried.commit).toBe(firstCommit);
    expect(
      (
        await engine.start({
          id: "parcel",
          blueprintId: "sample-process",
          commit: firstCommit,
        })
      ).commit,
    ).toBe(firstCommit);
    expect(pin).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    await expect(
      engine.start({
        id: "parcel",
        blueprintId: "sample-process",
        commit: secondCommit,
      }),
    ).rejects.toThrow("different invocation");
    await expect(
      engine.start({
        id: "parcel",
        blueprintId: "sample-process",
        commit: "HEAD",
        context: { changed: true },
      }),
    ).rejects.toThrow("different invocation");
    await expect(
      engine.start({
        id: "parcel",
        blueprintId: "other-process",
        commit: "HEAD",
      }),
    ).rejects.toThrow("different invocation");
    expect(restored.get("parcel").commit).toBe(firstCommit);
  } finally {
    restored.close();
  }
});

it("reopens a prior runs schema without changing an existing full-commit invocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "prior-revision-"));
  roots.push(root);
  const path = join(root, "runs.sqlite");
  const previous = new DatabaseSync(path);
  const commit = "a".repeat(40);
  previous.exec(`CREATE TABLE runs (
    id TEXT PRIMARY KEY, root_id TEXT NOT NULL, parent_id TEXT, parent_node_id TEXT,
    blueprint_id TEXT NOT NULL, blueprint_commit TEXT NOT NULL, blueprint TEXT NOT NULL,
    status TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
    initial_context TEXT NOT NULL, context TEXT NOT NULL, checkpoint TEXT NOT NULL
  )`);
  previous
    .prepare("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      "parcel",
      "parcel",
      null,
      null,
      "sample-process",
      commit,
      JSON.stringify({ id: "sample-process", nodes: [], edges: [] }),
      "awaiting",
      0,
      "{}",
      "{}",
      '{"context":{}}',
    );
  previous.close();
  const store = new RunStore(path);
  const pin = vi.fn<(revision: string) => Promise<string>>();
  const resolve = vi.fn();
  try {
    const row = store.db
      .prepare("SELECT requested_revision FROM runs WHERE id=?")
      .get("parcel");
    expect(row?.["requested_revision"]).toBeNull();
    const engine = new WorkflowEngine(store, {
      pinCommit: pin,
      resolveBlueprint: resolve,
    });
    const run = await engine.start({
      id: "parcel",
      blueprintId: "sample-process",
      commit,
    });
    expect(run.commit).toBe(commit);
    expect(run.requestedRevision).toBeUndefined();
    expect(pin).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  } finally {
    store.close();
  }
});
