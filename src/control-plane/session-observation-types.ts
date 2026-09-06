// ---
// relationships:
//   implements: heddle
//   references:
//     - t3-headless
//     - t3-session-visibility
// ---

import type {
  InstanceRecord,
  JsonValue,
  PersistedEvent,
} from "../persistence/index.js";
import type { PendingEscalation } from "../mcp-server/index.js";
import type {
  T3DispatchCommand,
  T3ShellSnapshot,
  T3ThreadSnapshot,
  T3UserInputQuestion,
} from "./t3-control-plane-client.js";

export type SessionObservationTarget = {
  instanceId: string;
  sessionKey: string;
  threadId: string;
};

export type SessionObservationThresholds = {
  endedMilliseconds: number;
  failedMilliseconds: number;
  stalledMilliseconds: number;
};

export type SessionObservationAttention = {
  attentionId: string;
  instanceId: string;
  kind: "approval" | "ended" | "failed" | "stalled" | "user-input";
  message: string;
  questions?: T3UserInputQuestion[];
  requestId?: string;
  sessionKey: string;
  threadId: string;
};

export interface SessionObservationAttentionQueue {
  has(attentionId: string): Promise<boolean>;
  raise(attention: SessionObservationAttention): Promise<void>;
  resolve(attentionId: string): boolean | Promise<boolean>;
}

export interface SessionObservationPersistence {
  appendEvent(
    instanceId: string,
    type: string,
    payload: JsonValue,
  ): PersistedEvent;
  getInstance(instanceId: string): InstanceRecord | undefined;
  listInstances(): InstanceRecord[];
  replayEvents(instanceId: string, afterSequence?: number): PersistedEvent[];
}

export interface SessionObservationEscalations {
  pendingEscalations(instanceId: string): PendingEscalation[];
  requireNoPendingForSession(instanceId: string, sessionKey: string): void;
}

export interface SessionObservationT3Client {
  dispatch(command: T3DispatchCommand): Promise<{ sequence: number }>;
  getShell(): Promise<T3ShellSnapshot>;
  getThread(threadId: string): Promise<T3ThreadSnapshot>;
  respondToApproval(
    threadId: string,
    requestId: string,
    decision: "accept" | "reject",
    commandId?: string,
  ): Promise<{ sequence: number }>;
  respondToUserInput(
    threadId: string,
    requestId: string,
    answers: Record<string, string | string[]>,
    commandId?: string,
  ): Promise<{ sequence: number }>;
}

export type SessionObservationResult = {
  archiveDispatched: boolean;
  attentions: SessionObservationAttention[];
  phase:
    | "absent"
    | "completed"
    | "failed"
    | "none"
    | "running"
    | "starting"
    | "waiting_for_approval"
    | "waiting_for_input";
};

export type StopSessionInput = SessionObservationTarget & {
  approvalDecisions?: Record<string, "accept" | "reject">;
  operationId: string;
  userInputAnswers?: Record<string, Record<string, string | string[]>>;
};

export type SessionObservationOptions = {
  attention: SessionObservationAttentionQueue;
  childStops?: {
    onObserved(
      target: SessionObservationTarget,
      result: SessionObservationResult,
    ): Promise<void>;
  };
  escalations: SessionObservationEscalations;
  nextId?: () => string;
  now?: () => number;
  persistence: SessionObservationPersistence;
  t3: SessionObservationT3Client;
  thresholds: SessionObservationThresholds;
};
