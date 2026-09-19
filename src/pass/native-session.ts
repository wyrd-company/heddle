// ---
// relationships:
//   implements: agent-tools
// ---
import type {
  OrchestrationEvent,
  OrchestrationSession,
} from "../t3code/index.js";
import { threadId } from "../t3code/index.js";
import type { RunStore } from "../engine/index.js";
import type { PassStore } from "./store.js";
import type { PassInvocation, PassOptions } from "./types.js";

/** Session states in which a provider session exists and can report its identity. */
const LIVE = new Set(["running", "ready", "interrupted"]);

/** The session a stock T3 Code event carries, when the event is session level. */
export function sessionEvent(
  event: OrchestrationEvent,
): OrchestrationSession | null {
  if ("unknown" in event || event.type !== "thread.session-set") return null;
  return event.payload.session;
}

/** Identifies one provider session, so a replaced or resumed one is asked about again. */
export function providerSessionKey(session: OrchestrationSession): string {
  return JSON.stringify([
    session.providerName,
    session.providerInstanceId ?? null,
  ]);
}

export type NativeSessionAction = "ask" | "clear" | "none";

/** One decision per observed session state: ask once, clear, or stay as is. */
export function nativeSessionAction(
  item: PassInvocation,
  session: OrchestrationSession | null,
): NativeSessionAction {
  const view = item.view;
  if (!session || !LIVE.has(session.status))
    return view.nativeSessionId === null && view.nativeSessionKey === null
      ? "none"
      : "clear";
  if (
    view.nativeSessionId !== null &&
    view.nativeSessionKey === providerSessionKey(session)
  )
    return "none";
  return "ask";
}

/** Records the answer against the pass, keeping usage attribution on the same identity. */
export function recordNativeSession(
  item: PassInvocation,
  sessionId: string | null,
  session: OrchestrationSession | null,
): void {
  const view = item.view;
  view.nativeSessionId = sessionId;
  view.nativeSessionKey =
    sessionId === null || !session ? null : providerSessionKey(session);
  if (sessionId !== null && view.usageSessionId !== sessionId) {
    view.usageBaseline = null;
    view.usageSessionId = sessionId;
  }
}

/** A lost subscription leaves the recorded identity unproven until it is read again. */
export function forgetNativeSession(item: PassInvocation): void {
  item.view.nativeSessionId = null;
  item.view.nativeSessionKey = null;
}

export interface NativeSessionContext {
  mcp: PassOptions["client"]["mcp"];
  store: PassStore;
  runs: RunStore;
  map: (item: PassInvocation) => void;
}

/**
 * Stock T3 Code does not publish the native harness session identity, so one
 * read per provider session learns it. An unanswered read is retried on the
 * thread's next session event, never on a clock. A failed read is recorded as
 * attention on the run and leaves the pass running.
 */
export async function learnNativeSession(
  item: PassInvocation,
  session: OrchestrationSession | null,
  context: NativeSessionContext,
): Promise<void> {
  const action = nativeSessionAction(item, session);
  if (action === "none") return;
  let learned: string | null = null;
  if (action === "ask") {
    try {
      learned = await context.mcp.nativeSessionId({
        threadId: threadId(item.threadId),
      });
    } catch (error) {
      context.runs.event(item.runId, "attention", {
        message: `Cannot read the native session identity of thread ${item.threadId}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    if (learned === null) return;
  }
  recordNativeSession(item, learned, session);
  context.store.saveObservation(item);
  context.map(item);
}
