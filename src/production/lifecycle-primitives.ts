// ---
// relationships:
//   implements: heddle
// ---

import {
  lifecycleProjectionOf,
  type LifecycleEffect,
} from "../engine/index.js";
import type { JsonValue, SqlitePersistence } from "../persistence/index.js";
import type { ReconcilerAttentionQueue } from "../reconciler/index.js";
import { createProductionErrorAttention } from "./error-visibility.js";
import { renderLifecycleText } from "./lifecycle-text.js";

/** A lifecycle started for an attention record carries its id here. */
export const sourceAttentionContextKey = "_heddleSourceAttentionId";

export const failNodeUse = "fail" as const;
export const resolveAttentionNodeUse = "resolve-attention" as const;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const taskIdFor = (
  persistence: SqlitePersistence,
  instanceId: string,
): number | undefined =>
  persistence
    .listReconcilerRuntime()
    .find((runtime) => runtime.instanceId === instanceId)?.taskId ??
  persistence
    .listIncidentRuntime()
    .find((incident) => incident.incidentId === instanceId)?.taskId;

/**
 * Two built-in terminal-side primitives an author can put in a graph.
 *
 * `fail` ends the lifecycle as a failure the operator must see: it raises
 * attention with `params.message` rendered over the lifecycle data. It
 * returns `{ failed: true }` so the graph's terminal output says what
 * happened.
 *
 * `resolve-attention` resolves the attention record this lifecycle was
 * started for, with the lifecycle id as justification.
 */
export const createLifecyclePrimitiveEffects = (options: {
  attention: Pick<ReconcilerAttentionQueue, "has" | "raise">;
  persistence: SqlitePersistence;
}): Record<
  typeof failNodeUse | typeof resolveAttentionNodeUse,
  LifecycleEffect
> => ({
  [failNodeUse]: async ({ context, nodeId, params }) => {
    const instanceId = await context.get("_heddleInstanceId");
    if (typeof instanceId !== "string") {
      throw new Error("Lifecycle instance id is missing from the context");
    }
    const template = params["message"];
    if (typeof template !== "string" || template.trim() === "") {
      throw new Error(
        `Fail node ${JSON.stringify(nodeId)} requires a non-empty params.message`,
      );
    }
    // The live context is ahead of the persisted one: it already holds the
    // nodes that finished during this run.
    const projection = lifecycleProjectionOf({
      serializedContext: JSON.stringify(await context.toJSON()),
    });
    const message = renderLifecycleText(
      template,
      { lifecycle: projection, task: projection.task },
      "fail message",
    );
    const taskId = taskIdFor(options.persistence, instanceId);
    // One attention per occurrence of this node; a retried effect finds it.
    const attentionId = `lifecycle:failed:${instanceId}:${nodeId}:${(projection.visits[nodeId] ?? 0) + 1}`;
    if (!(await options.attention.has(attentionId))) {
      await options.attention.raise(
        createProductionErrorAttention({
          attentionId,
          code: "lifecycle-failed",
          error: new Error(message),
          instanceId,
          message,
          ...(taskId === undefined ? {} : { taskId }),
        }),
      );
    }
    return { failed: true, message } satisfies Record<string, JsonValue>;
  },
  [resolveAttentionNodeUse]: async ({ context }) => {
    const instanceId = await context.get("_heddleInstanceId");
    const attentionId = await context.get(sourceAttentionContextKey);
    if (typeof instanceId !== "string") {
      throw new Error("Lifecycle instance id is missing from the context");
    }
    if (typeof attentionId !== "string" || attentionId === "") {
      throw new Error(
        "resolve-attention requires the attention this lifecycle was started for; none is recorded in the context",
      );
    }
    const resolved = options.persistence.resolveAttention(
      attentionId,
      instanceId,
    );
    return { attentionId, resolved } satisfies Record<string, JsonValue>;
  },
});

export const failed = (output: unknown): boolean =>
  asRecord(output)?.["failed"] === true;
