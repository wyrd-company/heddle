// ---
// relationships:
//   implements: heddle
// ---

import type {
  EdgeDefinition,
  IAsyncContext,
  NodeDefinition,
  WorkflowBlueprint,
  WorkflowStatus,
} from "flowcraft";

import type {
  FlowcraftHistory,
  InstanceRecord,
  InstanceState,
  JsonValue,
  PersistedEvent,
} from "../persistence/index.js";

export interface LifecycleEdge extends EdgeDefinition {
  description?: string;
  disposition?: string;
}

export interface LifecycleBlueprint extends WorkflowBlueprint {
  edges: LifecycleEdge[];
  nodes: NodeDefinition[];
}

export interface LifecycleEffectInput {
  context: IAsyncContext<Record<string, unknown>>;
  idempotencyKey: string;
  input: unknown;
  params: Record<string, unknown>;
}

export type LifecycleEffect = (
  input: LifecycleEffectInput,
) => Promise<JsonValue>;

export interface LifecyclePersistence {
  readonly flowcraftHistory: FlowcraftHistory;
  appendEvent(
    instanceId: string,
    type: string,
    payload: JsonValue,
  ): PersistedEvent;
  compareAndSwapInstance(
    instanceId: string,
    expectedVersion: number,
    state: InstanceState,
  ): InstanceRecord | undefined;
  createInstance(instanceId: string, state: InstanceState): InstanceRecord;
  getInstance(instanceId: string): InstanceRecord | undefined;
  updateInstance(instanceId: string, state: InstanceState): InstanceRecord;
}

export interface LifecycleEngineOptions {
  effects: Record<string, LifecycleEffect>;
  persistence: LifecyclePersistence;
  repositoryRoot: string;
}

export interface StartLifecycleInput {
  blueprintPath: string;
  initialContext?: Record<string, JsonValue>;
  instanceId: string;
  state?: Partial<
    Pick<InstanceState, "correlationTokens" | "handoffs" | "todoState">
  >;
}

export interface ResumeLifecycleInput {
  disposition: string;
  instanceId: string;
  output?: Record<string, JsonValue>;
}

export interface LifecycleSnapshot {
  awaitingNodeIds: string[];
  blueprintBlobHash: string;
  blueprintPath: string;
  executionIds: string[];
  instanceId: string;
  status: WorkflowStatus;
  validDispositions: string[];
}

export interface ExpectedLanding {
  awaitingNodeIds: string[];
  terminalNodeIds: string[];
}

export type ExpectedLandings = ExpectedLanding[];

export interface PendingTransition {
  disposition: string | null;
  id: string;
  initialContext: Record<string, JsonValue> | null;
  kind: "resume" | "start";
  output: Record<string, JsonValue> | null;
}

export interface LifecycleContextRecord {
  awaitingNodeIds: string[];
  blueprintBlobHash: string;
  blueprintPath: string;
  executionIds: string[];
  nextTransitionNumber: number;
  pendingTransition: PendingTransition | null;
  serializedContext: string | null;
  status: WorkflowStatus | "pending";
}
