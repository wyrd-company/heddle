// ---
// relationships:
//   implements: heddle
// ---

import type {
  T3ThreadActivity,
  T3ThreadSnapshot,
} from "./t3-control-plane-client.js";

const resolvedActivity = (
  snapshot: T3ThreadSnapshot,
  kind: "approval.resolved" | "user-input.resolved",
  requestId: string,
): T3ThreadActivity | undefined =>
  snapshot.thread.activities
    ?.filter(
      (activity) =>
        activity.kind === kind && activity.payload?.requestId === requestId,
    )
    .at(-1);

const canonicalAnswers = (
  answers: Record<string, string | string[]>,
): Record<string, string | string[]> =>
  Object.fromEntries(
    Object.entries(answers).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );

export const approvalResponseRecorded = (
  snapshot: T3ThreadSnapshot,
  requestId: string,
  decision: "accept" | "reject",
): boolean => {
  const activity = resolvedActivity(snapshot, "approval.resolved", requestId);
  if (activity === undefined) return false;
  const providerDecision = decision === "reject" ? "decline" : decision;
  if (activity.payload?.["decision"] !== providerDecision) {
    throw new Error(
      `T3 approval '${requestId}' resolved with a different decision`,
    );
  }
  return true;
};

export const userInputResponseRecorded = (
  snapshot: T3ThreadSnapshot,
  requestId: string,
  answers: Record<string, string | string[]>,
): boolean => {
  const activity = resolvedActivity(snapshot, "user-input.resolved", requestId);
  if (activity === undefined) return false;
  const recorded = activity.payload?.["answers"];
  if (
    typeof recorded !== "object" ||
    recorded === null ||
    Array.isArray(recorded) ||
    JSON.stringify(
      canonicalAnswers(recorded as Record<string, string | string[]>),
    ) !== JSON.stringify(canonicalAnswers(answers))
  ) {
    throw new Error(
      `T3 user input '${requestId}' resolved with different answers`,
    );
  }
  return true;
};
