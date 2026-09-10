// ---
// relationships:
//   implements: heddle
// ---

import type { ConsoleLifecycleEvent } from "./types.js";

export const lifecycleEventSummary = (
  event: ConsoleLifecycleEvent,
): string | undefined => {
  const payload = event.payload;
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return event.executionId;
  }
  if (event.type !== "mcp:escalation-answered") {
    return typeof payload["nodeId"] === "string"
      ? payload["nodeId"]
      : event.executionId;
  }
  const answeredBy = payload["answeredBy"];
  if (
    typeof answeredBy !== "object" ||
    answeredBy === null ||
    Array.isArray(answeredBy) ||
    answeredBy["kind"] !== "adjudication" ||
    typeof payload["modelSlug"] !== "string" ||
    typeof payload["answers"] !== "object" ||
    payload["answers"] === null ||
    Array.isArray(payload["answers"])
  ) {
    return event.executionId;
  }
  return `ADJUDICATION · ${payload["modelSlug"]} · ${JSON.stringify(payload["answers"])}`;
};
