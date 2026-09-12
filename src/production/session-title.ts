// ---
// relationships:
//   implements: heddle
//   references: t3-session-visibility
// ---

import { createHash } from "node:crypto";

export const MAXIMUM_SESSION_TITLE_LENGTH = 72;

const occurrenceDiscriminator = (
  occurrence: string,
  maximumLength: number,
): string => {
  const readable = occurrence
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const normalized = readable || "stage";
  if (normalized.length <= maximumLength) return normalized;
  const digest = createHash("sha256")
    .update(occurrence)
    .digest("hex")
    .slice(0, 8);
  return `${normalized.slice(0, maximumLength - digest.length - 1)}-${digest}`;
};

export const heddleSessionTitle = (
  taskId: number,
  occurrence: string,
): string => {
  if (!Number.isSafeInteger(taskId) || taskId <= 0) {
    throw new TypeError("taskId must be a positive safe integer");
  }
  if (occurrence.trim() === "") {
    throw new TypeError("occurrence must not be empty");
  }
  const prefix = `task-${taskId} · `;
  return `${prefix}${occurrenceDiscriminator(
    occurrence,
    MAXIMUM_SESSION_TITLE_LENGTH - prefix.length,
  )}`;
};
