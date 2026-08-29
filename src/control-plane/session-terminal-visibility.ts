// ---
// relationships:
//   implements: heddle
//   references: t3-session-visibility
// ---

import { resolveWorkflowMcpSessionBinding } from "../mcp-server/session-binding.js";
import {
  eventsForSession,
  objectPayload,
  sessionObservationEventTypes,
} from "./session-observation-events.js";
import { isStageSessionTerminal } from "./session-observation-liveness.js";
import type {
  SessionObservationOptions,
  SessionObservationTarget,
} from "./session-observation-types.js";
import type { T3ShellThread } from "./t3-control-plane-client.js";

const hasPendingEscalation = (
  options: SessionObservationOptions,
  target: SessionObservationTarget,
): boolean =>
  options.escalations
    .pendingEscalations(target.instanceId)
    .some(
      ({ ownerSessionKey, parentSessionKey }) =>
        ownerSessionKey === target.sessionKey ||
        parentSessionKey === target.sessionKey,
    );

const hasConversationalHandoff = (
  options: SessionObservationOptions,
  target: SessionObservationTarget,
): boolean => {
  const instance = options.persistence.getInstance(target.instanceId);
  if (instance === undefined) {
    throw new Error(`Instance does not exist: ${target.instanceId}`);
  }
  for (const value of instance.state.handoffs) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      value["parentSessionKey"] !== target.sessionKey ||
      typeof value["correlationToken"] !== "string"
    ) {
      continue;
    }
    try {
      const child = resolveWorkflowMcpSessionBinding(
        options.persistence,
        value["correlationToken"],
      );
      if (
        child.parentSessionKey === target.sessionKey &&
        child.stage.tools.some((tool) => tool !== "advance")
      ) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
};

const isActive = (thread: T3ShellThread): boolean =>
  thread.session?.status === "starting" ||
  thread.session?.status === "running" ||
  thread.latestTurn?.state === "running";

export const archiveTerminalSession = async (
  options: SessionObservationOptions,
  target: SessionObservationTarget,
  thread: T3ShellThread | undefined,
  nextId: () => string,
): Promise<boolean> => {
  const record = options.persistence.getInstance(target.instanceId);
  if (
    record === undefined ||
    !isStageSessionTerminal(record, target.sessionKey)
  ) {
    return false;
  }
  const events = eventsForSession(
    options.persistence.replayEvents(target.instanceId),
    target.sessionKey,
    target.threadId,
  );
  if (
    events.some(
      ({ type }) => type === sessionObservationEventTypes.archiveCompleted,
    )
  ) {
    return false;
  }
  if (
    thread === undefined ||
    isActive(thread) ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    hasPendingEscalation(options, target) ||
    hasConversationalHandoff(options, target)
  ) {
    return false;
  }
  let issued = events.find(
    ({ type }) => type === sessionObservationEventTypes.archiveIssued,
  );
  if (issued === undefined) {
    issued = options.persistence.appendEvent(
      target.instanceId,
      sessionObservationEventTypes.archiveIssued,
      { ...target, commandId: nextId() },
    );
  }
  const commandId = objectPayload(issued)["commandId"];
  if (typeof commandId !== "string") {
    throw new Error(`Archive event ${issued.sequence} has no command ID`);
  }
  await options.t3.dispatch({
    type: "thread.archive",
    commandId,
    threadId: target.threadId,
  });
  options.persistence.appendEvent(
    target.instanceId,
    sessionObservationEventTypes.archiveCompleted,
    { ...target, commandId },
  );
  return true;
};
