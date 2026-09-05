// ---
// relationships:
//   implements: heddle
// ---

import { createHash } from "node:crypto";

import {
  describeError,
  errorDetail,
  type ErrorDetail,
} from "../error-details.js";
import type { JsonValue } from "../persistence/index.js";
import type { NotificationDeliveryError } from "./durable-adapters.js";

export interface ProductionErrorAttention extends Record<string, JsonValue> {
  attentionId: string;
  code: string;
  error: ErrorDetail;
  instanceId: string | null;
  kind: "production-error";
  message: string;
  taskId: number | null;
}

export interface NotificationDeliveryAttention extends ProductionErrorAttention {
  notificationCategory: NotificationDeliveryError["category"];
  notificationOccurrence: number | null;
  notificationStableId: string;
}

const errorFingerprint = (error: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(errorDetail(error)))
    .digest("hex")
    .slice(0, 16);

export const productionErrorAttention = (input: {
  code: string;
  error: unknown;
  instanceId?: string;
  summary: string;
  taskId?: number;
  varyByError?: boolean;
}): ProductionErrorAttention => {
  const identity =
    input.taskId === undefined
      ? `global:${input.varyByError === true ? errorFingerprint(input.error) : input.code}`
      : `task:${input.taskId}${input.instanceId === undefined ? "" : `:${input.instanceId}`}`;
  return {
    attentionId: `production:${input.code}:${identity}`,
    code: input.code,
    error: errorDetail(input.error),
    instanceId: input.instanceId ?? null,
    kind: "production-error",
    message: `${input.summary}: ${describeError(input.error)}`,
    taskId: input.taskId ?? null,
  };
};

const notificationIdentity = (
  stableId: string,
  retryableCategory?: NotificationDeliveryError["category"],
): string =>
  createHash("sha256")
    .update(
      retryableCategory === undefined
        ? stableId
        : JSON.stringify({ retryableCategory, stableId }),
    )
    .digest("hex")
    .slice(0, 16);

export const notificationDeliveryErrorAttention = (input: {
  error: NotificationDeliveryError;
  instanceId: string;
  stableId: string;
  taskId: number;
}): NotificationDeliveryAttention => {
  const occurrence = input.error.occurrence;
  const retryable = input.error.disposition === "retryable";
  const identity = notificationIdentity(
    input.stableId,
    retryable ? input.error.category : undefined,
  );
  const code = retryable
    ? "notification-delivery-retryable"
    : input.error.disposition === "operator-action"
      ? "notification-delivery-recovery-required"
      : "notification-delivery-rejected";
  if (!retryable && occurrence === undefined) {
    throw new Error("Permanent notification failure has no occurrence");
  }
  const recovery = retryable
    ? "Heddle will retry the unchanged notification on a later pass."
    : input.error.disposition === "operator-action"
      ? "Verify the intended recipient and message, then retry this exact notification."
      : "Repair the secure notification configuration, restart Heddle, then retry this exact notification.";
  return {
    attentionId: `production:${code}:task:${input.taskId}:${identity}${occurrence === undefined ? "" : `:${occurrence}`}`,
    code,
    error: errorDetail(input.error),
    instanceId: input.instanceId,
    kind: "production-error",
    message: `Notification delivery ${retryable ? "will be retried" : input.error.disposition === "operator-action" ? "requires recovery" : "was rejected"} (${input.error.category}). ${recovery}`,
    notificationCategory: input.error.category,
    notificationOccurrence: occurrence ?? null,
    notificationStableId: input.stableId,
    taskId: input.taskId,
  };
};
