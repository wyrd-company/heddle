// ---
// relationships:
//   implements: heddle
// ---

import type { BoardTask } from "../board-adapter/index.js";
import type { PacingDeferral } from "../pacing/index.js";
import type { JsonValue } from "../persistence/index.js";

export interface ConsoleBoard {
  readBoard(): Promise<BoardTask[]>;
  readBoardStatuses(): Promise<string[]>;
  setEpicInProgress(taskId: number, inProgress: boolean): Promise<void>;
}

export interface ConsoleInstance {
  deferral?: PacingDeferral;
  instanceId: string;
  stageEnteredAt?: number;
  stageId?: string;
  taskId: number;
}

export interface ConsoleEvent {
  instanceId: string;
  payload: JsonValue;
  recordedAt: string;
  sequence: number;
  type: string;
}

export interface ConsoleAttention {
  actions: ConsoleAttentionAction[];
  attentionId: string;
  fingerprint: string;
  heading: string;
  instanceId?: string;
  kind: string;
  message: string;
  notificationVerification?: {
    message: string;
    recipientLabel: string;
  };
  scope: ConsoleAttentionScope;
  taskId?: number;
}

export type ConsoleAttentionScope = "all" | `epic:${number}` | `task:${number}`;

export type ConsoleAttentionQuestion = {
  header?: string;
  id: string;
  multiSelect: boolean;
  options: Array<{
    description?: string;
    label: string;
    value: string;
  }>;
  prompt: string;
};

export type ConsoleAttentionActionInput =
  | { kind: "none" }
  | { kind: "questions"; questions: ConsoleAttentionQuestion[] };

export type ConsoleAttentionActionContract =
  | { kind: "attention.resolve" }
  | {
      kind: "notification.retry";
      occurrence: number;
    }
  | {
      escalationId: string;
      instanceId: string;
      kind: "escalation.answer";
      ownerSessionKey: string;
    }
  | {
      decision: "accept" | "reject";
      instanceId: string;
      kind: "t3.approval.respond";
      requestId: string;
      sessionKey: string;
      threadId: string;
    }
  | {
      instanceId: string;
      kind: "t3.user-input.respond";
      requestId: string;
      sessionKey: string;
      threadId: string;
    };

export type ConsoleAttentionAction = {
  actionId: string;
  contract: ConsoleAttentionActionContract;
  input: ConsoleAttentionActionInput;
  label: string;
};

export type ConsoleAttentionActionAnswers = Record<string, string | string[]>;

export type ConsoleAttentionActionRequest = {
  answers?: ConsoleAttentionActionAnswers;
  fingerprint: string;
};

export interface ConsoleAttentionActionPort {
  execute(input: {
    action: ConsoleAttentionAction;
    answers?: ConsoleAttentionActionAnswers;
    attention: ConsoleAttention;
  }): Promise<void>;
}

export interface ConsoleLifecycleEvent {
  executionId: string;
  payload: JsonValue;
  sequence: number;
  type: string;
}

export interface ConsoleLifecycleBlueprint {
  blobHash: string;
  edges: Array<{
    condition?: string;
    source: string;
    target: string;
  }>;
  id: string;
  nodes: Array<{
    id: string;
    uses: string;
  }>;
  path: string;
}

export interface ConsoleLifecycleSnapshot {
  blueprint: ConsoleLifecycleBlueprint;
  currentStageIds: string[];
  events: ConsoleLifecycleEvent[];
  instanceId: string;
  nextSequence: number;
  rebase: ConsoleLifecycleRebaseAvailability;
  status: string;
  taskId: number;
}

export type ConsoleLifecycleRebaseAvailability =
  | {
      state: "current";
      targetBlueprintBlobHash: string;
      targetStateIds: string[];
    }
  | {
      state: "available";
      targetBlueprintBlobHash: string;
      targetStateIds: string[];
    }
  | { state: "upstream-target-unavailable" };

export type ConsoleLifecycleRebaseRequest = {
  expectedInstanceId: string;
  expectedPinnedBlobHash: string;
  expectedTargetBlobHash: string;
  targetState: string;
};

export interface ConsoleLifecycleActionPort {
  rebase(input: { instanceId: string; targetState: string }): Promise<void>;
}

export class ConsoleLifecycleUnavailableError extends Error {}

export class ConsoleLifecycleNotStartedError extends ConsoleLifecycleUnavailableError {}

export interface ConsoleStateSource {
  listAttention(): Promise<ConsoleAttention[]>;
  listCorrelationTokens(): Promise<string[]>;
  listEvents(input: {
    afterSequence: number;
    instanceId?: string;
  }): Promise<ConsoleEvent[]>;
  listInstances(): Promise<ConsoleInstance[]>;
  readLifecycle(input: {
    afterSequence: number;
    taskId: number;
  }): Promise<ConsoleLifecycleSnapshot>;
}
