import { nodeId } from "../refs.js";
import type { FieldValue, IssueFieldSchema, ProjectSchema, Snapshot } from "../schema/types.js";
import type { ItemData } from "./item.js";
import type { RawItem } from "./parse.js";

/**
 * Shapes decoded item values to the declared schema: every declared field is
 * present (null when unset). An undeclared project keeps every readable value.
 */
export function pickValues<P extends ProjectSchema, S extends IssueFieldSchema>(
  schema: P,
  values: Record<string, FieldValue | null>,
): Snapshot<P, S> {
  const names = Object.keys(schema.fields);
  if (names.length === 0) return { ...values } as Snapshot<P, S>;
  const out: Record<string, FieldValue | null> = {};
  for (const name of names) out[name] = values[name] ?? null;
  return out as Snapshot<P, S>;
}

/** Public item data from a raw wire item. */
export function itemData<P extends ProjectSchema, S extends IssueFieldSchema>(
  schema: P,
  raw: RawItem,
): ItemData<P, S> {
  return {
    id: raw.id,
    type: raw.type,
    contentId: raw.contentId === null ? null : nodeId(raw.contentId),
    contentRef: raw.contentRef,
    title: raw.title,
    archived: raw.archived,
    values: pickValues<P, S>(schema, raw.values),
  };
}
