import type { Context } from "../context.js";
import { reconcile, type EnsureChange, type ReconcileOption } from "../schema/reconcile.js";
import { NotFoundError } from "../transport/errors.js";
import type { CatalogAdapter } from "./adapter.js";

export interface EnsureReport<T> {
  changes: EnsureChange[];
  resources: T[];
}

/** One shape for every named resource: labels, milestones, issue types, issue fields, project fields. */
export interface Catalog<T, Spec> {
  list(): AsyncIterable<T>;
  /** Throws NotFoundError. */
  get(name: string): Promise<T>;
  find(name: string): Promise<T | undefined>;
  create(spec: Spec): Promise<T>;
  update(name: string, patch: Partial<Spec>): Promise<T>;
  /** Idempotent: a missing resource is not an error. */
  delete(name: string): Promise<void>;
  /** Create what is missing and update what differs. Never deletes. */
  ensure(specs: Spec | readonly Spec[]): Promise<EnsureReport<T>>;
}

export function createCatalog<T, Spec>(
  ctx: Context,
  adapter: CatalogAdapter<T, Spec>,
): Catalog<T, Spec> {
  const table = () =>
    ctx.cache.table<T>(adapter.scope, async () => {
      const entries: [string, T][] = [];
      for await (const item of adapter.list()) entries.push([adapter.keyOf(item), item]);
      return entries;
    });
  const invalidate = () => ctx.cache.invalidate(adapter.scope);

  const find = async (name: string) => (await table()).get(name);
  const get = async (name: string) => {
    const found = await find(name);
    if (found === undefined) throw new NotFoundError(adapter.resource, name);
    return found;
  };

  return {
    list: () => adapter.list(),
    get,
    find,
    async create(spec) {
      const created = await adapter.create(spec);
      invalidate();
      return created;
    },
    async update(name, patch) {
      const updated = await adapter.update(await get(name), patch);
      invalidate();
      return updated;
    },
    async delete(name) {
      const existing = await find(name);
      if (existing === undefined) return;
      await adapter.delete(existing);
      invalidate();
    },
    async ensure(specs) {
      const declared = Array.isArray(specs) ? (specs as readonly Spec[]) : [specs as Spec];
      const actual = [...(await table()).values()];
      const plan = reconcile<Spec, T>({
        declared,
        actual,
        keyOf: (v) => adapter.keyOf(v),
        diff: (s, e) => adapter.diff(s, e),
        ...(adapter.typeOf ? { typeOf: (v: T | Spec) => adapter.typeOf!(v) } : {}),
        ...(adapter.optionsOf ? { optionsOf: (e: T) => adapter.optionsOf!(e) } : {}),
        ...(adapter.specOptionsOf ? { specOptionsOf: (s: Spec) => adapter.specOptionsOf!(s) } : {}),
        ...(adapter.reportUnmanaged ? { reportUnmanaged: true } : {}),
      });
      const byKey = new Map(actual.map((a) => [adapter.keyOf(a), a]));
      for (const op of plan.operations) {
        if (op.kind === "create") {
          const created = await adapter.create(op.spec);
          byKey.set(adapter.keyOf(created), created);
        } else {
          const existing = byKey.get(op.name);
          if (existing === undefined) throw new NotFoundError(adapter.resource, op.name);
          const updated = await adapter.update(
            existing,
            op.patch as Partial<Spec> & { options?: ReconcileOption[] },
          );
          byKey.set(op.name, updated);
        }
      }
      if (plan.operations.length > 0) invalidate();
      const resources = declared
        .map((spec) => byKey.get(adapter.keyOf(spec)))
        .filter((r): r is T => r !== undefined);
      return { changes: plan.changes, resources };
    },
  };
}
