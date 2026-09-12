// ---
// relationships:
//   implements: heddle
// ---

import type { JsonValue } from "./persistence/index.js";

export interface ErrorDetail extends Record<string, JsonValue> {
  cause: ErrorDetail | null;
  message: string;
  name: string;
}

const maximumCauseDepth = 8;

export const errorDetail = (
  value: unknown,
  seen: ReadonlySet<object> = new Set(),
  depth = 0,
): ErrorDetail => {
  if (!(value instanceof Error)) {
    return { cause: null, message: String(value), name: "Error" };
  }
  const detail: ErrorDetail = {
    cause: null,
    message: value.message,
    name: value.name === "" ? "Error" : value.name,
  };
  if (
    depth >= maximumCauseDepth ||
    value.cause === undefined ||
    (typeof value.cause === "object" &&
      value.cause !== null &&
      seen.has(value.cause))
  ) {
    return detail;
  }
  const nextSeen = new Set(seen);
  nextSeen.add(value);
  return {
    ...detail,
    cause: errorDetail(value.cause, nextSeen, depth + 1),
  };
};

export const describeError = (value: unknown): string => {
  return describeErrorDetail(errorDetail(value));
};

export const describeErrorDetail = (detail: ErrorDetail): string =>
  detail.cause === null
    ? detail.message
    : `${detail.message}; caused by: ${describeErrorDetail(detail.cause)}`;
