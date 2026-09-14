// ---
// relationships:
//   implements: heddle
// ---

import type { JsonValue } from "../persistence/index.js";
import type { LifecycleBlueprint, LifecycleContextRecord } from "./types.js";

/**
 * Context key under which Heddle publishes what the graph has done so far, in
 * a shape an author can read from an edge condition or a handoff template
 * without knowing Flowcraft's internal keys.
 */
export const lifecycleContextKey = "lifecycle";

export type LifecycleProjection = {
  blueprint: { metadata: Record<string, JsonValue> };
  current: { node: string; visit: number } | null;
  outputs: Record<string, JsonValue>;
  task: JsonValue;
  visits: Record<string, number>;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export const initialProjection = (
  blueprint: LifecycleBlueprint,
  initialContext: Record<string, unknown>,
): LifecycleProjection => ({
  blueprint: {
    metadata: (asRecord(blueprint.metadata) ?? {}) as Record<string, JsonValue>,
  },
  current: null,
  outputs: {},
  task: (initialContext["taskContract"] ?? null) as JsonValue,
  visits: {},
});

/** Reads the projection back from a workflow context; absent means empty. */
export const projectionFrom = (
  context: Record<string, unknown>,
): LifecycleProjection => {
  const value = asRecord(context[lifecycleContextKey]);
  return {
    blueprint: {
      metadata: (asRecord(asRecord(value?.["blueprint"])?.["metadata"]) ??
        {}) as Record<string, JsonValue>,
    },
    current:
      (asRecord(value?.["current"]) as LifecycleProjection["current"]) ?? null,
    outputs: (asRecord(value?.["outputs"]) ?? {}) as Record<string, JsonValue>,
    task: (value?.["task"] ?? null) as JsonValue,
    visits: Object.fromEntries(
      Object.entries(asRecord(value?.["visits"]) ?? {}).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      ),
    ),
  };
};

/**
 * Records that `nodeId` finished with `output`: its latest output, one more
 * visit, and that it is the current node. Returns the context to publish.
 */
export const recordNodeFinish = (
  context: Record<string, unknown>,
  nodeId: string,
  output: unknown,
): Record<string, unknown> => {
  const projection = projectionFrom(context);
  const visit = (projection.visits[nodeId] ?? 0) + 1;
  const next: LifecycleProjection = {
    ...projection,
    current: { node: nodeId, visit },
    outputs: {
      ...projection.outputs,
      [nodeId]: (output ?? null) as JsonValue,
    },
    visits: { ...projection.visits, [nodeId]: visit },
  };
  return { ...context, [lifecycleContextKey]: next };
};

/** The projection persisted with an instance, for templates and tools. */
export const lifecycleProjectionOf = (
  context: Pick<LifecycleContextRecord, "serializedContext">,
): LifecycleProjection =>
  projectionFrom(
    context.serializedContext === null
      ? {}
      : (JSON.parse(context.serializedContext) as Record<string, unknown>),
  );
