import { describe, expect, it } from "vitest";
import { NameCache } from "../cache.js";
import type { Context } from "../context.js";
import { collect } from "../transport/paginate.js";
import { ScriptedTransport } from "../testing/scripted-transport.js";
import { createExecute } from "../transport/execute.js";
import { NotFoundError } from "../transport/errors.js";
import { diffProperties, type CatalogAdapter } from "./adapter.js";
import { createCatalog } from "./catalog.js";

interface Spice {
  id: string;
  name: string;
  heat: number;
}
interface SpiceSpec {
  name: string;
  heat?: number;
}

function memoryAdapter(initial: Spice[]) {
  const store = new Map(initial.map((s) => [s.id, s]));
  let listCalls = 0;
  let next = store.size;
  const adapter: CatalogAdapter<Spice, SpiceSpec> = {
    resource: "spice",
    scope: "spices:test",
    keyOf: (v) => v.name,
    async *list() {
      listCalls += 1;
      yield* store.values();
    },
    async create(spec) {
      const created = { id: `s${(next += 1)}`, name: spec.name, heat: spec.heat ?? 0 };
      store.set(created.id, created);
      return created;
    },
    async update(existing, patch) {
      const updated = { ...existing, ...patch };
      store.set(existing.id, updated);
      return updated;
    },
    async delete(existing) {
      store.delete(existing.id);
    },
    diff: (spec, existing) => diffProperties(spec, existing, ["heat"]),
  };
  return { adapter, store, listCalls: () => listCalls };
}

function context(): Context {
  const transport = new ScriptedTransport();
  return {
    transport,
    cache: new NameCache(),
    execute: createExecute(transport),
    relationshipPageSize: 100,
  };
}

describe("catalog", () => {
  it("indexes by name, loads once, and invalidates on writes", async () => {
    const mem = memoryAdapter([{ id: "s1", name: "cumin", heat: 1 }]);
    const catalog = createCatalog(context(), mem.adapter);
    expect(await catalog.find("cumin")).toMatchObject({ id: "s1" });
    expect(await catalog.find("nope")).toBeUndefined();
    await expect(catalog.get("nope")).rejects.toBeInstanceOf(NotFoundError);
    expect(mem.listCalls()).toBe(1);

    await catalog.create({ name: "chili", heat: 5 });
    expect(await catalog.get("chili")).toMatchObject({ heat: 5 });
    expect(mem.listCalls()).toBe(2);

    await catalog.update("chili", { heat: 7 });
    expect((await catalog.get("chili")).heat).toBe(7);
    await catalog.delete("chili");
    await catalog.delete("chili");
    expect(await collect(catalog.list())).toHaveLength(1);
  });

  it("ensure creates and updates from specs and reports changes", async () => {
    const mem = memoryAdapter([{ id: "s1", name: "cumin", heat: 1 }]);
    const catalog = createCatalog(context(), mem.adapter);
    const report = await catalog.ensure([
      { name: "cumin", heat: 2 },
      { name: "paprika", heat: 3 },
      { name: "cumin", heat: 2 },
    ]);
    expect(report.changes).toEqual([
      { kind: "updated", name: "cumin", properties: ["heat"] },
      { kind: "created", name: "paprika" },
      { kind: "updated", name: "cumin", properties: ["heat"] },
    ]);
    expect(report.resources.map((r) => r.name)).toEqual(["cumin", "paprika", "cumin"]);
    expect([...mem.store.values()].map((s) => `${s.name}:${s.heat}`)).toEqual([
      "cumin:2",
      "paprika:3",
    ]);
    const again = await catalog.ensure({ name: "paprika", heat: 3 });
    expect(again.changes).toEqual([{ kind: "unchanged", name: "paprika" }]);
  });
});
