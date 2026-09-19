import type { ReconcileOption } from "../schema/reconcile.js";
import type { OptionSpec } from "../schema/types.js";
import { notImplemented } from "../transport/errors.js";

/**
 * What one named resource family must provide for the generic Catalog.
 * Internal: never on the public surface.
 */
export interface CatalogAdapter<T, Spec> {
  /** Resource name for error messages, e.g. "label". */
  readonly resource: string;
  /** Cache scope for the name table. */
  readonly scope: string;
  keyOf(value: T | Spec): string;
  list(): AsyncIterable<T>;
  create(spec: Spec): Promise<T>;
  /** `patch.options`, when present, is the full merged option list to write. */
  update(existing: T, patch: Partial<Spec> & { options?: ReconcileOption[] }): Promise<T>;
  delete(existing: T): Promise<void>;
  /** Property names whose values differ, excluding the key and options. */
  diff(spec: Spec, existing: T): string[];
  typeOf?(value: T | Spec): string | undefined;
  optionsOf?(existing: T): readonly ReconcileOption[] | undefined;
  specOptionsOf?(spec: Spec): readonly OptionSpec[] | undefined;
  readonly reportUnmanaged?: boolean;
}

/** Shallow diff over the given property names. Adapters compose their `diff` from it. */
export function diffProperties<Spec, T>(
  spec: Spec,
  existing: T,
  properties: readonly (keyof Spec & keyof T & string)[],
): string[] {
  const out: string[] = [];
  for (const property of properties) {
    const wanted = spec[property];
    if (wanted === undefined) continue;
    if (!sameValue(wanted, existing[property])) out.push(property);
  }
  return out;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  return false;
}

/** Placeholder adapter for a family not yet implemented. Every method throws UNSUPPORTED. */
export function unimplementedAdapter<T, Spec>(
  resource: string,
  scope: string,
): CatalogAdapter<T, Spec> {
  const fail = () => notImplemented(`${resource} catalog`);
  return {
    resource,
    scope,
    keyOf: fail,
    list: fail,
    create: fail,
    update: fail,
    delete: fail,
    diff: fail,
  };
}
