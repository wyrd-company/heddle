// ---
// relationships:
//   implements: node-types
// ---
import {
  applyThreadEvent,
  pendingRequests,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
} from "../t3code/index.js";
import type { PassInvocation, TokenUsage } from "./types.js";
import { record } from "./prepare.js";

export function observePass(
  item: PassInvocation,
  event: OrchestrationEvent,
): boolean {
  if (
    "unknown" in event ||
    event.sequence <= (item.sequence ?? -1) ||
    !item.projection
  )
    return false;
  item.sequence = event.sequence;
  item.projection = applyThreadEvent(item.projection, event);
  const view = item.view;
  if (event.type === "thread.turn-start-requested")
    view.pendingMessageId = event.payload.messageId;
  if (event.type === "thread.message-sent" && event.payload.role === "user")
    view.pendingMessageId = event.payload.messageId;
  if (view.pendingMessageId === item.messageId) view.started = true;
  if (!view.started) {
    if (
      event.type === "thread.activity-appended" &&
      event.payload.activity.kind === "context-window.updated"
    )
      view.usageBaseline = usage(record(event.payload.activity.payload));
    return true;
  }
  view.lastActivity = Math.max(
    view.lastActivity ?? 0,
    Date.parse(event.occurredAt),
  );
  if (event.type === "thread.session-set") {
    const session = event.payload.session;
    if (session.activeTurnId && !view.turns[session.activeTurnId]) {
      const source =
        view.pendingMessageId === item.messageId ? "heddle" : "operator";
      view.turns[session.activeTurnId] = { source, state: "running" };
      view.turnCount++;
      if (source === "operator") view.operatorTurnCount++;
    }
  }
  if (event.type === "thread.activity-appended")
    observeActivity(item, event.payload.activity);
  const turn = item.projection.latestTurn;
  if (turn && view.turns[turn.turnId]) {
    const observed = view.turns[turn.turnId];
    if (observed) observed.state = turn.state;
  }
  view.openRequests = pendingRequests(item.projection);
  return true;
}
function observeActivity(
  item: PassInvocation,
  activity: OrchestrationThreadActivity,
): void {
  const payload = record(activity.payload),
    view = item.view;
  if (
    activity.kind.startsWith("task.") &&
    typeof payload["taskId"] === "string"
  ) {
    const id = payload["taskId"];
    const previous = view.helpers[id];
    const usage = { ...record(previous?.["typedUsage"]) };
    for (const [key, value] of Object.entries(record(payload["typedUsage"]))) {
      if (typeof value === "number")
        usage[key] = Math.max(number(usage[key]), value);
    }
    view.helpers[id] = {
      ...previous,
      ...payload,
      typedUsage: usage,
      kind: activity.kind,
    };
  }
  if (activity.kind === "context-compaction")
    view.compactions.push({ id: activity.id, ...payload });
  if (activity.kind !== "context-window.updated") return;
  const used = number(payload["usedTokens"]),
    max = number(payload["maxTokens"]);
  if (max > 0) {
    view.previousContextRatio = view.contextRatio;
    view.contextRatio = used / max;
  }
  const next = usage(payload);
  const key = JSON.stringify([
    item.projection?.modelSelection.instanceId,
    item.projection?.modelSelection.model,
  ]);
  const total = view.usageByModel[key] ?? { total: 0 };
  const prior = view.usageBaseline?.total ?? 0;
  total.total += Math.max(0, next.total - prior);
  view.usageByModel[key] = total;
  view.usageBaseline = { total: Math.max(prior, next.total) };
}
function usage(payload: Record<string, unknown>): TokenUsage {
  return {
    total: number(payload["totalProcessedTokens"] ?? payload["usedTokens"]),
  };
}

const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export function seedPass(item: PassInvocation): void {
  const thread = item.projection;
  if (!thread) return;
  item.view.openRequests = pendingRequests(thread);
  const last = thread.activities.findLast(
    (activity) => activity.kind === "context-window.updated",
  );
  if (last) item.view.usageBaseline = usage(record(last.payload));
}
