// ---
// relationships:
//   implements: heddle
// ---

import { requestIdFor } from "./session-observation-attention.js";
import {
  eventWithOperation,
  eventsForSession,
  objectPayload,
  sessionObservationEventTypes,
} from "./session-observation-events.js";
import type {
  SessionObservationOptions,
  SessionObservationTarget,
  StopSessionInput,
} from "./session-observation-types.js";
import type {
  T3ShellThread,
  T3ThreadSnapshot,
} from "./t3-control-plane-client.js";

const issueCommand = async (
  options: SessionObservationOptions,
  target: SessionObservationTarget,
  operationId: string,
  issuedType: string,
  completedType: string,
  commandType: "thread.session.stop" | "thread.turn.interrupt",
  nextId: () => string,
): Promise<void> => {
  if (operationId.trim() === "") {
    throw new TypeError("operationId must not be empty");
  }
  const events = eventsForSession(
    options.persistence.replayEvents(target.instanceId),
    target.sessionKey,
    target.threadId,
  );
  if (eventWithOperation(events, completedType, operationId) !== undefined) {
    return;
  }
  let issued = eventWithOperation(events, issuedType, operationId);
  if (issued === undefined) {
    issued = options.persistence.appendEvent(target.instanceId, issuedType, {
      ...target,
      commandId: nextId(),
      operationId,
    });
  }
  const commandId = objectPayload(issued)["commandId"];
  if (typeof commandId !== "string") {
    throw new Error(`Issued event ${issued.sequence} has no command ID`);
  }
  await options.t3.dispatch({
    type: commandType,
    commandId,
    threadId: target.threadId,
  });
  options.persistence.appendEvent(target.instanceId, completedType, {
    ...target,
    commandId,
    operationId,
  });
};

const dispositionQuestion = async (
  options: SessionObservationOptions,
  input: StopSessionInput,
  kind: "approval" | "user-input",
  requestId: string,
  decision: "accept" | "reject" | Record<string, string | string[]>,
  nextId: () => string,
): Promise<void> => {
  if (typeof decision === "object" && Object.keys(decision).length === 0) {
    throw new Error(
      `Explicit disposition is required for pending ${kind} '${requestId}'`,
    );
  }
  const operationId = `${input.operationId}:${kind}:${requestId}`;
  const events = eventsForSession(
    options.persistence.replayEvents(input.instanceId),
    input.sessionKey,
    input.threadId,
  );
  if (
    eventWithOperation(
      events,
      sessionObservationEventTypes.questionDispositionCompleted,
      operationId,
    ) !== undefined
  ) {
    return;
  }
  let issued = eventWithOperation(
    events,
    sessionObservationEventTypes.questionDispositionIssued,
    operationId,
  );
  if (issued === undefined) {
    issued = options.persistence.appendEvent(
      input.instanceId,
      sessionObservationEventTypes.questionDispositionIssued,
      {
        ...input,
        commandId: nextId(),
        decision,
        kind,
        operationId,
        requestId,
      },
    );
  }
  const commandId = objectPayload(issued)["commandId"];
  if (typeof commandId !== "string") {
    throw new Error(
      `Question disposition event ${issued.sequence} has no command ID`,
    );
  }
  if (kind === "approval") {
    await options.t3.respondToApproval(
      input.threadId,
      requestId,
      decision as "accept" | "reject",
      commandId,
    );
  } else {
    await options.t3.respondToUserInput(
      input.threadId,
      requestId,
      decision as Record<string, string | string[]>,
      commandId,
    );
  }
  options.persistence.appendEvent(
    input.instanceId,
    sessionObservationEventTypes.questionDispositionCompleted,
    { ...input, commandId, kind, operationId, requestId },
  );
};

const dispositionPendingQuestions = async (
  options: SessionObservationOptions,
  input: StopSessionInput,
  thread: T3ShellThread,
  snapshot: T3ThreadSnapshot,
  nextId: () => string,
): Promise<void> => {
  const pending = [
    ...(thread.hasPendingApprovals ? (["approval"] as const) : []),
    ...(thread.hasPendingUserInput ? (["user-input"] as const) : []),
  ];
  for (const kind of pending) {
    const activity =
      kind === "approval" ? "approval.requested" : "user-input.requested";
    const requestId = requestIdFor(snapshot, activity);
    if (requestId === undefined) {
      throw new Error(`T3 reports pending ${kind} without a request ID`);
    }
    const decision =
      kind === "approval"
        ? input.approvalDecisions?.[requestId]
        : input.userInputAnswers?.[requestId];
    if (decision === undefined) {
      throw new Error(
        `Explicit disposition is required for pending ${kind} '${requestId}'`,
      );
    }
    await dispositionQuestion(
      options,
      input,
      kind,
      requestId,
      decision,
      nextId,
    );
  }
};

export const interruptSession = async (
  options: SessionObservationOptions,
  target: SessionObservationTarget,
  operationId: string,
  nextId: () => string,
): Promise<void> =>
  issueCommand(
    options,
    target,
    operationId,
    sessionObservationEventTypes.interruptIssued,
    sessionObservationEventTypes.interruptCompleted,
    "thread.turn.interrupt",
    nextId,
  );

export const stopSession = async (
  options: SessionObservationOptions,
  input: StopSessionInput,
  nextId: () => string,
): Promise<void> => {
  options.escalations.requireNoPendingForSession(
    input.instanceId,
    input.sessionKey,
  );
  const shell = await options.t3.getShell();
  const thread = shell.threads.find(({ id }) => id === input.threadId);
  if (thread === undefined) throw new Error("Cannot stop an absent T3 thread");
  const snapshot = await options.t3.getThread(input.threadId);
  await dispositionPendingQuestions(options, input, thread, snapshot, nextId);
  await issueCommand(
    options,
    input,
    input.operationId,
    sessionObservationEventTypes.sessionStopIssued,
    sessionObservationEventTypes.sessionStopCompleted,
    "thread.session.stop",
    nextId,
  );
};
