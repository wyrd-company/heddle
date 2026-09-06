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

export const productionErrorCodeDeclarations = {
  "board-task-absent": { incidentEligible: true },
  "child-promotion-failed": { incidentEligible: true },
  "dynamic-task-authority-ambiguous": { incidentEligible: true },
  "dynamic-task-authority-conflicting": { incidentEligible: true },
  "dynamic-task-authority-failed": { incidentEligible: false },
  "dynamic-task-authority-malformed": { incidentEligible: true },
  "epic-project-reconciliation-failed": { incidentEligible: true },
  "epic-status-transition-failed": { incidentEligible: true },
  "instance-synchronization-failed": { incidentEligible: true },
  "lifecycle-attention-bridge-failed": { incidentEligible: true },
  "lifecycle-execution-failed": { incidentEligible: true },
  "lifecycle-instance-absent": { incidentEligible: true },
  "notification-delivery-recovery-required": { incidentEligible: true },
  "notification-delivery-rejected": { incidentEligible: true },
  "notification-delivery-retryable": { incidentEligible: true },
  "scheduler-pass-failed": { incidentEligible: false },
  "session-observation-failed": { incidentEligible: true },
  "session-page-delivery-failed": { incidentEligible: true },
  "stale-attention-failed": { incidentEligible: true },
  "task-reconciliation-failed": { incidentEligible: true },
  "task-status-mirror-failed": { incidentEligible: true },
} as const;

export type ProductionErrorCode = keyof typeof productionErrorCodeDeclarations;

const floorMessage =
  "An incident cannot be raised for this error. Operator action is required.";

export const productionErrorIncidentId = (attentionId: string): string =>
  `incident:${createHash("sha256").update(attentionId).digest("hex")}`;

export const productionErrorIncidentEligible = (
  code: ProductionErrorCode,
): boolean => {
  if (!Object.hasOwn(productionErrorCodeDeclarations, code)) {
    throw new Error(
      `Production error code '${code}' has no incident eligibility`,
    );
  }
  return productionErrorCodeDeclarations[code].incidentEligible;
};

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
      : `task:${input.taskId}${input.instanceId === undefined ? "" : `:${input.instanceId}`}`;
  return createProductionErrorAttention({
    attentionId: `production:${input.code}:${identity}`,
    code: input.code,
    error: input.error,
    ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
    message: `${input.summary}: ${describeError(input.error)}`,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
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
    ...createProductionErrorAttention({
      attentionId: `production:${code}:task:${input.taskId}:${identity}${occurrence === undefined ? "" : `:${occurrence}`}`,
      code,
      error: input.error,
      instanceId: input.instanceId,
      message: `Notification delivery ${retryable ? "will be retried" : input.error.disposition === "operator-action" ? "requires recovery" : "was rejected"} (${input.error.category}). ${recovery}`,
      taskId: input.taskId,
    }),
    notificationCategory: input.error.category,
    notificationOccurrence: occurrence ?? null,
    notificationStableId: input.stableId,
  };
};
