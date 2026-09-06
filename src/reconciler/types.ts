// ---
// relationships:
//   implements: heddle
// ---

import type { BoardTask } from "../board-adapter/index.js";
import type { LifecycleResolution } from "../engine/index.js";
import type {
  DispatchPacingEvaluator,
  PacingDeferral,
} from "../pacing/index.js";
import type { ErrorDetail } from "../error-details.js";
import type { ProductionErrorAttention } from "../production/error-visibility.js";

export interface ReconcilerBoard {
  mirrorTaskStatus(taskId: number, status: string): Promise<void>;
  readBoard(): Promise<BoardTask[]>;
  transitionEpicStatus(taskId: number, status: "done" | "uat"): Promise<void>;
}

export interface ReconcilerInstance {
  boardStatus: string;
  boardStatusMirrorBlocked?: boolean;
  deferral?: PacingDeferral;
  depth?: number;
  instanceId: string;
  parentSessionId?: string;
  provider?: string;
  stageEnteredAt?: number;
  stageId?: string;
  state: "deferred" | "done" | "running" | "starting" | "waiting";
  taskId: number;
}

export interface StartReconcilerInstanceInput {
  blueprintPath: string;
  dispatch?: {
    depth: 0;
    provider: string;
  };
  instanceId: string;
  repositoryName?: string;
  task: BoardTask;
}

export interface DeferReconcilerInstanceInput {
  boardStatus: string;
  deferral: PacingDeferral;
  depth: 0;
  instanceId: string;
  provider: string;
  taskId: number;
}

export interface ReconcilerInstanceController {
  defer(input: DeferReconcilerInstanceInput): Promise<void>;
  listInstances(): Promise<ReconcilerInstance[]>;
  start(input: StartReconcilerInstanceInput): Promise<void>;
}

export interface ReconcilerLifecycleResolver {
  resolve(task: BoardTask): Promise<LifecycleResolution>;
}

type ReconcilerConditionAttention = {
  artifactId?: string;
  attentionId: string;
  code: string;
  error?: ErrorDetail;
  instanceId?: string;
  kind: "epic-acceptance" | "lifecycle-resolution" | "stale-instance";
  message: string;
  taskId: number;
};

export type ReconcilerAttention =
  ProductionErrorAttention | ReconcilerConditionAttention;

export interface ReconcilerAttentionQueue {
  has(attentionId: string): Promise<boolean>;
  raise(attention: ReconcilerAttention): Promise<void>;
  reopen(attentionId: string): boolean;
  resolve(attentionId: string): boolean;
}

export interface ReconcilerPacing {
  evaluator: DispatchPacingEvaluator;
  providerFor?(
    task: BoardTask,
    resolution: Extract<LifecycleResolution, { kind: "resolved" }>,
  ): Promise<string>;
}

export interface ReconcilerDynamicTaskAuthority {
  hasPendingForEpic(epicId: number): boolean;
  verifyTask(task: BoardTask): unknown | undefined;
}

export interface ReconcilerEpicOperations {
  run<T>(epicId: number, operation: () => Promise<T>): Promise<T>;
}

export interface ReconcilerOptions {
  attention: ReconcilerAttentionQueue;
  board: ReconcilerBoard;
  instances: ReconcilerInstanceController;
  lifecycleResolver: ReconcilerLifecycleResolver;
  dynamicTasks?: ReconcilerDynamicTaskAuthority;
  epicOperations?: ReconcilerEpicOperations;
  now?: () => number;
  pacing?: ReconcilerPacing;
  staleThresholds?: Readonly<Record<string, number>>;
}

export type ReconciliationAction =
  | {
      from: string;
      kind: "task-status-transition";
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
      repositoryName?: string;
      taskId: number;
    }
  | {
      deferral: PacingDeferral;
      instanceId: string;
      kind: "dispatch-deferred";
      provider: string;
      taskId: number;
    }
  | {
      from: string;
      kind: "epic-status-transition";
      taskId: number;
      to: "done" | "uat";
    };
