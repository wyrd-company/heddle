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

export interface ProductionErrorAttention extends Record<string, JsonValue> {
  attentionId: string;
  code: string;
  error: ErrorDetail;
  instanceId: string | null;
  kind: "production-error";
  message: string;
  taskId: number | null;
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
