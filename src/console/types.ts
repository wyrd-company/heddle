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
  attentionId: string;
  instanceId?: string;
  kind: string;
  message: string;
  taskId?: number;
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
  status: string;
  taskId: number;
}

export class ConsoleLifecycleUnavailableError extends Error {}

export interface ConsoleStateSource {
  listAttention(): Promise<ConsoleAttention[]>;
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
