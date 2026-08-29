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

export interface ConsoleStateSource {
  listAttention(): Promise<ConsoleAttention[]>;
  listEvents(input: {
    afterSequence: number;
    instanceId?: string;
  }): Promise<ConsoleEvent[]>;
  listInstances(): Promise<ConsoleInstance[]>;
}
