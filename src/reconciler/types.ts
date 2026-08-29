// ---
// relationships:
//   implements: heddle
// ---

import type { BoardTask } from "../board-adapter/index.js";
import type { LifecycleResolution } from "../engine/index.js";

export interface ReconcilerBoard {
  mirrorChildStatus(taskId: number, status: string): Promise<void>;
  readBoard(): Promise<BoardTask[]>;
  transitionEpicStatus(taskId: number, status: "done" | "uat"): Promise<void>;
}

export interface ReconcilerInstance {
  boardStatus: string;
  instanceId: string;
  stageEnteredAt?: number;
  stageId?: string;
  state: "done" | "running" | "waiting";
  taskId: number;
}

export interface StartReconcilerInstanceInput {
  blueprintPath: string;
  instanceId: string;
  task: BoardTask;
}

export interface ReconcilerInstanceController {
  listInstances(): Promise<ReconcilerInstance[]>;
  start(input: StartReconcilerInstanceInput): Promise<void>;
}

export interface ReconcilerLifecycleResolver {
  resolve(task: BoardTask): Promise<LifecycleResolution>;
}

export interface ReconcilerAttention {
  artifactId?: string;
  attentionId: string;
  code: string;
  instanceId?: string;
  kind: "lifecycle-resolution" | "stale-instance";
  message: string;
  taskId: number;
}

export interface ReconcilerAttentionQueue {
  has(attentionId: string): Promise<boolean>;
  raise(attention: ReconcilerAttention): Promise<void>;
}

export interface ReconcilerOptions {
  attention: ReconcilerAttentionQueue;
  board: ReconcilerBoard;
  instances: ReconcilerInstanceController;
  lifecycleResolver: ReconcilerLifecycleResolver;
  now?: () => number;
  staleThresholds?: Readonly<Record<string, number>>;
}

export type ReconciliationAction =
  | {
      from: string;
      kind: "child-status-transition";
      taskId: number;
      to: string;
    }
  | {
      attention: ReconcilerAttention;
      kind: "attention-raised";
    }
  | {
      blueprintPath: string;
      instanceId: string;
      kind: "instance-start";
      taskId: number;
    }
  | {
      from: string;
      kind: "epic-status-transition";
      taskId: number;
      to: "done" | "uat";
    };
