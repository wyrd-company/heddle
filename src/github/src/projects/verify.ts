import { normaliseOption } from "../schema/reconcile.js";
import type { FieldSpec, ProjectSchema } from "../schema/types.js";
import type { SchemaGap } from "../transport/errors.js";
import type { ProjectField, ProjectFieldSpec } from "./fields.js";

/** Catalog specs derived from a declared project schema, in declaration order. */
export function specsFromSchema(schema: ProjectSchema): ProjectFieldSpec[] {
  return Object.entries(schema.fields).map(([name, spec]) => ({ name, ...spec }));
}

/** Pure: every way the live fields fall short of the declaration. Empty means conformant. */
export function verifySchema(schema: ProjectSchema, fields: readonly ProjectField[]): SchemaGap[] {
  const gaps: SchemaGap[] = [];
  for (const [name, spec] of Object.entries(schema.fields)) {
    const field = fields.find((f) => f.name === name);
    if (!field) {
      gaps.push({ kind: "missing-field", field: name });
      continue;
    }
    if (field.type !== spec.type) {
      gaps.push({ kind: "type-mismatch", field: name, detail: `${spec.type} vs ${field.type}` });
      continue;
    }
    for (const missing of missingOptions(spec, field)) {
      gaps.push({ kind: "missing-option", field: name, detail: missing });
    }
  }
  return gaps;
}

function missingOptions(spec: FieldSpec, field: ProjectField): string[] {
  if (!("options" in spec)) return [];
  const present = new Set(field.options.map((o) => o.name));
  return spec.options.map((o) => normaliseOption(o).name).filter((n) => !present.has(n));
}
