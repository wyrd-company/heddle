// ---
// relationships:
//   implements: heddle
//   references: t3-headless
// ---

export type T3AwarenessPhase =
  | "waiting_for_approval"
  | "waiting_for_input"
  | "failed"
  | "starting"
  | "running"
  | "completed"
  | "none";

export type T3ShellThread = {
  id: string;
  backgroundLiveness?: "working" | "monitoring" | null;
  hasActionableProposedPlan?: boolean;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
  latestUserMessageAt?: string | null;
  session?: {
    lastError?: string | null;
    status?: string;
  } | null;
  latestTurn?: {
    state?: string;
    requestedAt?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
  } | null;
};

export const resolveT3AwarenessPhase = (
  thread: T3ShellThread,
): T3AwarenessPhase => {
  if (thread.hasPendingApprovals) return "waiting_for_approval";
  if (thread.hasPendingUserInput) return "waiting_for_input";
  if (
    thread.session?.status === "error" ||
    thread.latestTurn?.state === "error"
  )
    return "failed";
  if (thread.session?.status === "starting") return "starting";
  if (
    thread.session?.status === "running" ||
    thread.latestTurn?.state === "running"
  )
    return "running";
  if (thread.latestTurn?.state === "completed") return "completed";
  if (
    thread.latestTurn?.state === "interrupted" &&
    thread.latestTurn.completedAt != null
  )
    return "completed";
  if (thread.session?.status === "ready" || thread.session?.status === "idle")
    return "completed";
  return "none";
};
