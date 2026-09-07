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
  ResolvedSessionRuntimeMode,
} from "../persistence/index.js";
import type { ErrorDetail } from "../error-details.js";

export type LifecycleOutputContract =
  "incident-diagnosis" | "optional" | "review-findings";

export interface LifecycleEdge extends EdgeDefinition {
  description?: string;
  disposition?: string;
  "output-contract"?: LifecycleOutputContract;
}

export interface LifecycleNode extends NodeDefinition {
  handoff?: "remediation" | "standard";
  "handoff-template"?: {
    commitSha: string;
    path: string;
  };
  repo?: string;
  "provider-alias"?: string;
  "runtime-mode"?: ResolvedSessionRuntimeMode;
  skills?: string[];
  "todo-template"?: string;
  tools?: string[];
}

export interface LifecycleBlueprint extends WorkflowBlueprint {
  "board-statuses"?: Partial<Record<MechanicalNodeUse, string>>;
  edges: LifecycleEdge[];
  nodes: LifecycleNode[];
}

export const mechanicalNodeUses = [
  "finalize",
  "merge",
  "prepare-worktree",
  "review-snapshot",
] as const;

export type MechanicalNodeUse = (typeof mechanicalNodeUses)[number];

export interface LifecycleEffectInput {
  blueprint: LifecycleBlueprint;
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
  replayEvents(instanceId: string, afterSequence?: number): PersistedEvent[];
  updateInstance(instanceId: string, state: InstanceState): InstanceRecord;
}

export interface LifecycleEngineOptions {
  effects: Record<string, LifecycleEffect>;
  persistence: LifecyclePersistence;
  repositoryRoot: string;
  sourceRef?: string;
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
  operationId: string;
  output?: Record<string, JsonValue>;
}

export interface RebaseLifecycleInput {
  instanceId: string;
  targetState: string;
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

export interface CompletedLifecycleOperation {
  awaitingNodeIds: string[];
  executionIds: string[];
  requestFingerprint: string;
  status: WorkflowStatus;
  transitionId: string;
}

export interface LifecycleAttention extends Record<string, JsonValue> {
  actualAwaitingNodeIds: string[];
  actualStatus: WorkflowStatus;
  attentionId: string;
  errors: ErrorDetail[];
  executionId: string | null;
  expectedAwaitingNodeIds: string[];
  expectedTerminalNodeIds: string[];
  transitionId: string;
}

export interface PendingTransition {
  disposition: string | null;
  id: string;
  initialContext: Record<string, JsonValue> | null;
  kind: "resume" | "start";
  operationId: string | null;
  output: Record<string, JsonValue> | null;
  requestFingerprint: string | null;
}

export interface LifecycleContextRecord {
  awaitingNodeIds: string[];
  blueprintBlobHash: string;
  blueprintPath: string;
  completedOperations: Record<string, CompletedLifecycleOperation>;
  executionIds: string[];
  mcpDispositionClaims?: Record<string, string>;
  nextTransitionNumber: number;
  pendingAttentions: LifecycleAttention[];
  pendingTransition: PendingTransition | null;
  serializedContext: string | null;
  status: WorkflowStatus | "pending";
}
