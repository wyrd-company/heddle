// ---
// relationships:
//   implements: heddle
// ---

import type { JsonValue } from "../persistence/index.js";

const sanitizeString = (value: string, secrets: readonly string[]): string => {
  let sanitized = value.replace(
    /\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu,
    "$1[redacted]@",
  );
  for (const secret of secrets) {
    if (secret !== "") sanitized = sanitized.replaceAll(secret, "[redacted]");
  }
  return sanitized;
};

export const sanitizeIncidentValue = (
  value: JsonValue,
  secrets: readonly string[],
): JsonValue => {
  if (typeof value === "string") return sanitizeString(value, secrets);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeIncidentValue(item, secrets));
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sanitizeIncidentValue(item, secrets),
    ]),
  );
};
