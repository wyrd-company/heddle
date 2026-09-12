// ---
// relationships:
//   implements: heddle
// ---

import { createHash } from "node:crypto";

import {
  describeError,
  describeErrorDetail,
  errorDetail,
  type ErrorDetail,
} from "../error-details.js";
import type { JsonValue } from "../persistence/index.js";
import type { NotificationDeliveryError } from "./durable-adapters.js";

export const schedulerPassFailureCode = "scheduler-pass-failed" as const;

/**
 * These failures cannot safely invoke incident response. Every other production
 * failure is admitted by retry policy without first being added to a catalog.
 */
export const operatorOnlyProductionErrorCodes = new Set<string>([
  "dynamic-task-authority-failed",
  "incident-execution-failed",
  "provider-alias-exhausted",
  "provider-fallback-active",
  schedulerPassFailureCode,
]);

export type ProductionErrorCode = string;

const floorMessage =
  "An incident cannot be raised for this error. Operator action is required.";

export const productionErrorIncidentId = (
  attentionId: string,
  occurrence = 1,
): string => {
  if (!Number.isSafeInteger(occurrence) || occurrence <= 0) {
    throw new TypeError("Incident occurrence must be a positive safe integer");
  }
  const identity =
    occurrence === 1
      ? attentionId
      : JSON.stringify({ attentionId, occurrence, type: "incident" });
  return `incident:${createHash("sha256").update(identity).digest("hex")}`;
};

export const productionErrorIncidentEligible = (
  code: ProductionErrorCode,
): boolean => !operatorOnlyProductionErrorCodes.has(code);

export interface ProductionErrorAttention extends Record<string, JsonValue> {
  attentionId: string;
  code: ProductionErrorCode;
  error: ErrorDetail;
  incidentId: string | null;
  instanceId: string | null;
  kind: "production-error";
  message: string;
  taskId: number | null;
}

type ProductionErrorAttentionInput = {
  attentionId: string;
  code: ProductionErrorCode;
  instanceId?: string;
  message: string;
  taskId?: number;
} & (
  | { error: unknown; parsedError?: never }
  | { error?: never; parsedError: ErrorDetail }
);

export const createProductionErrorAttention = (
  input: ProductionErrorAttentionInput,
): ProductionErrorAttention => {
  if (input.code.trim() === "") {
    throw new TypeError("Production error code must not be empty");
  }
  const incidentEligible = productionErrorIncidentEligible(input.code);
  return {
    attentionId: input.attentionId,
    code: input.code,
    error:
      input.parsedError === undefined
        ? errorDetail(input.error)
        : input.parsedError,
    incidentId: incidentEligible
      ? productionErrorIncidentId(input.attentionId)
      : null,
    instanceId: input.instanceId ?? null,
    kind: "production-error",
    message: `${input.message}${incidentEligible ? "" : ` ${floorMessage}`}`,
    taskId: input.taskId ?? null,
  };
};

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
  code: ProductionErrorCode;
  error: unknown;
  instanceId?: string;
  summary: string;
  taskId?: number;
  varyByError?: boolean;
}): ProductionErrorAttention => {
  const identity =
    input.taskId === undefined
      ? `global:${input.varyByError === true ? errorFingerprint(input.error) : input.code}`
      : `task:${input.taskId}${input.instanceId === undefined ? "" : `:${input.instanceId}`}${input.varyByError === true ? `:${errorFingerprint(input.error)}` : ""}`;
  return createProductionErrorAttention({
    attentionId: `production:${input.code}:${identity}`,
    code: input.code,
    error: input.error,
    ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
    message: `${input.summary}: ${describeError(input.error)}`,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
  });
};

export const schedulerPassFailureAttention = (input: {
  episode: number;
  error: ErrorDetail;
}): ProductionErrorAttention => {
  if (!Number.isSafeInteger(input.episode) || input.episode <= 0) {
    throw new TypeError(
      "Scheduler pass episode must be a positive safe integer",
    );
  }
  return createProductionErrorAttention({
    attentionId: `production:${schedulerPassFailureCode}:global:episode:${input.episode}`,
    code: schedulerPassFailureCode,
    parsedError: input.error,
    message: `Production reconciliation pass failed: ${describeErrorDetail(input.error)}`,
  });
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
  instanceId?: string;
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
    ...createProductionErrorAttention({
      attentionId: `production:${code}:task:${input.taskId}:${identity}${occurrence === undefined ? "" : `:${occurrence}`}`,
      code,
      error: input.error,
      ...(input.instanceId === undefined
        ? {}
        : { instanceId: input.instanceId }),
      message: `Notification delivery ${retryable ? "will be retried" : input.error.disposition === "operator-action" ? "requires recovery" : "was rejected"} (${input.error.category}). ${recovery}`,
      taskId: input.taskId,
    }),
    notificationCategory: input.error.category,
    notificationOccurrence: occurrence ?? null,
    notificationStableId: input.stableId,
  };
};
