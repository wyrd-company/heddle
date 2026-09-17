import type { OptionSpec } from "./types.js";

export type EnsureChange =
  | { kind: "created"; name: string }
  | { kind: "updated"; name: string; properties: string[] }
  | { kind: "unchanged"; name: string }
  | { kind: "option-added"; field: string; option: string }
  | { kind: "option-updated"; field: string; option: string; properties: string[] }
  | { kind: "option-unmanaged"; field: string; option: string }
  | { kind: "field-unmanaged"; field: string }
  | { kind: "type-mismatch"; name: string; expected: string; actual: string };

/** An option as it exists on GitHub or as reconcile emits it for an update. */
export interface ReconcileOption {
  id?: string;
  name: string;
  color?: string;
  description?: string;
}

export type ReconcileOperation<Spec> =
  | { kind: "create"; spec: Spec }
  | { kind: "update"; name: string; patch: Partial<Spec> & { options?: ReconcileOption[] } };

export interface ReconcilePlan<Spec> {
  changes: EnsureChange[];
  operations: ReconcileOperation<Spec>[];
}

export interface ReconcileInput<Spec, T> {
  declared: readonly Spec[];
  actual: readonly T[];
  keyOf(value: Spec | T): string;
  /** Property names whose values differ, excluding the key and options. */
  diff(spec: Spec, existing: T): string[];
  typeOf?(value: Spec | T): string | undefined;
  optionsOf?(existing: T): readonly ReconcileOption[] | undefined;
  specOptionsOf?(spec: Spec): readonly OptionSpec[] | undefined;
  /** Report actual resources the declaration does not mention. */
  reportUnmanaged?: boolean;
}

/**
 * Pure planner shared by every catalog. Never plans a deletion: options and
 * resources on GitHub that the declaration omits are reported, not removed.
 */
export function reconcile<Spec, T>(input: ReconcileInput<Spec, T>): ReconcilePlan<Spec> {
  const changes: EnsureChange[] = [];
  const operations: ReconcileOperation<Spec>[] = [];
  const existingByKey = new Map(input.actual.map((a) => [input.keyOf(a), a]));
  const declaredKeys = new Set<string>();

  for (const spec of input.declared) {
    const name = input.keyOf(spec);
    declaredKeys.add(name);
    const existing = existingByKey.get(name);
    if (existing === undefined) {
      changes.push({ kind: "created", name });
      operations.push({ kind: "create", spec });
      continue;
    }
    const expected = input.typeOf?.(spec);
    const actual = input.typeOf?.(existing);
    if (expected !== undefined && actual !== undefined && expected !== actual) {
      changes.push({ kind: "type-mismatch", name, expected, actual });
      continue;
    }
    const properties = input.diff(spec, existing);
    const patch: Partial<Spec> & { options?: ReconcileOption[] } = {};
    for (const property of properties) {
      (patch as Record<string, unknown>)[property] = (spec as Record<string, unknown>)[property];
    }
    const options = reconcileOptions(
      name,
      input.specOptionsOf?.(spec) ?? defaultSpecOptions(spec),
      input.optionsOf?.(existing) ?? defaultOptions(existing),
      changes,
    );
    if (options) {
      patch.options = options;
      properties.push("options");
    }
    if (properties.length === 0) {
      changes.push({ kind: "unchanged", name });
      continue;
    }
    changes.push({ kind: "updated", name, properties });
    operations.push({ kind: "update", name, patch });
  }

  if (input.reportUnmanaged) {
    for (const key of existingByKey.keys()) {
      if (!declaredKeys.has(key)) changes.push({ kind: "field-unmanaged", field: key });
    }
  }
  return { changes, operations };
}

/** Returns the merged option list when anything must change, else undefined. */
function reconcileOptions(
  field: string,
  declared: readonly OptionSpec[] | undefined,
  actual: readonly ReconcileOption[] | undefined,
  changes: EnsureChange[],
): ReconcileOption[] | undefined {
  if (!declared) return undefined;
  const existing = new Map((actual ?? []).map((o) => [o.name, o]));
  const merged: ReconcileOption[] = [];
  let dirty = false;

  for (const raw of declared) {
    const spec = normaliseOption(raw);
    const current = existing.get(spec.name);
    if (!current) {
      changes.push({ kind: "option-added", field, option: spec.name });
      merged.push(spec);
      dirty = true;
      continue;
    }
    const properties = optionDiff(spec, current);
    if (properties.length > 0) {
      changes.push({ kind: "option-updated", field, option: spec.name, properties });
      dirty = true;
    }
    merged.push({ ...current, ...spec });
  }
  for (const current of existing.values()) {
    if (!declared.some((d) => normaliseOption(d).name === current.name)) {
      changes.push({ kind: "option-unmanaged", field, option: current.name });
      merged.push(current);
    }
  }
  return dirty ? merged : undefined;
}

export function normaliseOption(option: OptionSpec): ReconcileOption {
  if (typeof option === "string") return { name: option };
  const out: ReconcileOption = { name: option.name };
  if (option.color !== undefined) out.color = option.color;
  if (option.description !== undefined) out.description = option.description;
  return out;
}

function optionDiff(spec: ReconcileOption, current: ReconcileOption): string[] {
  const out: string[] = [];
  if (spec.color !== undefined && spec.color !== current.color) out.push("color");
  if (spec.description !== undefined && spec.description !== current.description) {
    out.push("description");
  }
  return out;
}

function defaultSpecOptions(spec: unknown): readonly OptionSpec[] | undefined {
  const options = (spec as { options?: unknown }).options;
  return Array.isArray(options) ? (options as OptionSpec[]) : undefined;
}

function defaultOptions(existing: unknown): readonly ReconcileOption[] | undefined {
  const options = (existing as { options?: unknown }).options;
  return Array.isArray(options) ? (options as ReconcileOption[]) : undefined;
}
