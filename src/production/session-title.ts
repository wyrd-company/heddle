// ---
// relationships:
//   implements: heddle
//   references: t3-session-visibility
// ---

import { createHash } from "node:crypto";

export const MAXIMUM_HEDDLE_TITLE_LENGTH = 72;

const stageDiscriminator = (stageId: string): string => {
  const readable = stageId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  const digest = createHash("sha256").update(stageId).digest("hex").slice(0, 8);
  return `${readable || "stage"}-${digest}`;
};

export const heddleSessionTitle = (taskId: number, stageId: string): string => {
  if (!Number.isSafeInteger(taskId) || taskId <= 0) {
    throw new TypeError("taskId must be a positive safe integer");
  }
  if (stageId.trim() === "") throw new TypeError("stageId must not be empty");
  const title = `Heddle · task-${taskId} · ${stageDiscriminator(stageId)}`;
  if (title.length > MAXIMUM_HEDDLE_TITLE_LENGTH) {
    throw new Error("Heddle session title exceeds its length bound");
  }
  return title;
};
