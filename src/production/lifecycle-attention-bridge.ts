// ---
// relationships:
//   implements: heddle
// ---

import {
  describeError,
  describeErrorDetail,
  errorDetail,
  type ErrorDetail,
} from "../error-details.js";
import { readLifecycleContext } from "../engine/index.js";
import type {
  JsonValue,
  ReconcilerRuntimeRecord,
  SqlitePersistence,
} from "../persistence/index.js";
import type { DurableAttentionQueue } from "./durable-adapters.js";
import {
  createProductionErrorAttention,
  type ProductionErrorAttention,
} from "./error-visibility.js";

const lifecycleAttentionEvent = "lifecycle:attention-required";

const payloadRecord = (payload: JsonValue): Record<string, JsonValue> => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new Error("Lifecycle attention payload is not an object");
  }
  return payload;
};

const requiredString = (
  payload: Record<string, JsonValue>,
  key: string,
): string => {
  const value = payload[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Lifecycle attention has no ${key}`);
  }
  return value;
};

const errorsFrom = (payload: Record<string, JsonValue>): ErrorDetail[] => {
  const errors = payload["errors"];
  if (!Array.isArray(errors)) return [];
  return errors.filter((value): value is ErrorDetail => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    return (
      typeof value["message"] === "string" && typeof value["name"] === "string"
    );
  });
};

export class LifecycleAttentionBridge {
  constructor(
    private readonly persistence: SqlitePersistence,
    private readonly attention: DurableAttentionQueue,
  ) {}

  async flush(): Promise<void> {
    for (const runtime of this.persistence.listReconcilerRuntime()) {
      try {
        await this.#flushRuntime(runtime);
      } catch (error) {
        await this.#raiseBridgeFailure(runtime, error);
      }
    }
  }

  async #flushRuntime(runtime: ReconcilerRuntimeRecord): Promise<void> {
    const record = this.persistence.getInstance(runtime.instanceId);
    const context =
      record === undefined ? undefined : readLifecycleContext(record);
    for (const event of this.persistence
      .replayEvents(runtime.instanceId)
      .filter(({ type }) => type === lifecycleAttentionEvent)) {
      const payload = payloadRecord(event.payload);
      const transitionId = requiredString(payload, "transitionId");
      const attentionId = `production:lifecycle-execution-failed:task:${runtime.taskId}:${runtime.instanceId}:${transitionId}`;
      const transitionCompleted =
        context !== undefined &&
        (Object.values(context.completedOperations).some(
          (operation) => operation.transitionId === transitionId,
        ) ||
          (transitionId === `${runtime.instanceId}:1` &&
            context.serializedContext !== null &&
            context.pendingTransition?.id !== transitionId));
      if (transitionCompleted) {
        if (await this.attention.has(attentionId)) {
          this.attention.resolve(attentionId);
        }
        continue;
      }
      if (await this.attention.has(attentionId)) {
        this.attention.reopen(attentionId);
        continue;
      }
      const errors = errorsFrom(payload);
      const actualStatus = payload["actualStatus"];
      const summary =
        errors.length === 0
          ? `Lifecycle transition ${transitionId} landed as ${String(actualStatus)}`
          : describeErrorDetail(errors[0]!);
      const attention: ProductionErrorAttention =
        createProductionErrorAttention({
          attentionId,
          code: "lifecycle-execution-failed",
          parsedError:
            errors[0] ??
            errorDetail(
              new Error(
                `Lifecycle transition ${transitionId} landed as ${String(actualStatus)}`,
              ),
            ),
          instanceId: runtime.instanceId,
          message: `Instance ${runtime.instanceId} requires lifecycle attention: ${summary}`,
          taskId: runtime.taskId,
        });
      await this.attention.raise(attention);
    }
  }

  async #raiseBridgeFailure(
    runtime: ReconcilerRuntimeRecord,
    error: unknown,
  ): Promise<void> {
    const attentionId = `production:lifecycle-attention-bridge-failed:task:${runtime.taskId}:${runtime.instanceId}`;
    if (await this.attention.has(attentionId)) return;
    await this.attention.raise(
      createProductionErrorAttention({
        attentionId,
        code: "lifecycle-attention-bridge-failed",
        error,
        instanceId: runtime.instanceId,
        message: `Instance ${runtime.instanceId} attention bridge failed: ${describeError(error)}`,
        taskId: runtime.taskId,
      }),
    );
  }
}
