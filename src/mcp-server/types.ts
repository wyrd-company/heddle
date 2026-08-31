// ---
// relationships:
//   implements: heddle
// ---

import type { McpServer } from "@modelcontextprotocol/server";

import type { LifecycleSnapshot } from "../engine/index.js";
import type {
  InstanceEventClaim,
  InstanceRecord,
  JsonValue,
  PersistedEvent,
} from "../persistence/index.js";
import type { EscalationCoordinator } from "./escalation-coordinator.js";
import type { SubagentCoordinator } from "../subagents/coordinator.js";
import type { AdvanceOutputContract } from "./advance-output.js";

export interface WorkflowMcpPersistence {
  appendEvent(
    instanceId: string,
    type: string,
    payload: JsonValue,
  ): PersistedEvent;
  compareAndSwapInstanceWithEvent(
    instanceId: string,
    expectedVersion: number,
    state: InstanceRecord["state"],
    type: string,
    payload: JsonValue,
  ): InstanceEventClaim | undefined;
  compareAndSwapInstance(
    instanceId: string,
    expectedVersion: number,
    state: InstanceRecord["state"],
  ): InstanceRecord | undefined;
  getInstance(instanceId: string): InstanceRecord | undefined;
  listInstances(): InstanceRecord[];
  replayEvents(instanceId: string, afterSequence?: number): PersistedEvent[];
}

export interface WorkflowMcpLifecycle {
  resume(input: {
    disposition: string;
    instanceId: string;
    operationId: string;
    output?: Record<string, JsonValue>;
  }): Promise<LifecycleSnapshot>;
}

export interface WorkflowMcpDisposition {
  [key: string]: JsonValue;
  description: string;
  name: string;
  /** Readers normalize an absent pre-contract value to null. */
  outputContract: AdvanceOutputContract | null;
}

export interface WorkflowMcpSessionBinding {
  dispositions: WorkflowMcpDisposition[];
  instance: InstanceRecord;
  parentSessionKey?: string;
  sessionKey: string;
  stage: { id: string; tools: string[] };
  taskContext: JsonValue;
  todoAssignment?: {
    listSessionKey: string;
    rootItemId: string;
  };
  token: string;
}

export interface WorkflowMcpStageContract {
  [key: string]: JsonValue;
  blueprintBlobHash: string;
  blueprintPath: string;
  dispositions: WorkflowMcpDisposition[];
  handoffTemplate: {
    blobHash: string;
    path: string;
  };
  stage: string;
  todoTemplate: string;
  tools: string[];
}

export interface WorkflowMcpToolContext {
  binding: WorkflowMcpSessionBinding;
  escalationCoordinator: EscalationCoordinator;
  lifecycle: WorkflowMcpLifecycle;
  persistence: WorkflowMcpPersistence;
}

export interface WorkflowMcpToolContributor {
  name: string;
  register(server: McpServer, context: WorkflowMcpToolContext): void;
}

export interface WorkflowMcpHandlerOptions {
  escalationCoordinator?: EscalationCoordinator;
  lifecycle: WorkflowMcpLifecycle;
  persistence: WorkflowMcpPersistence;
  subagentCoordinator?: SubagentCoordinator;
  tools?: readonly WorkflowMcpToolContributor[];
}

export interface CorrelationTokenMatch {
  instance: InstanceRecord;
  sessionKey: string;
  token: string;
}

export type StoredStageHandoff = {
  correlationToken: string;
  handoff: string;
  kind: "stage-handoff";
  parentSessionKey?: string;
  sessionKey: string;
  renderedHandoff?: string;
  todoAssignment?: {
    listSessionKey: string;
    rootItemId: string;
  };
  workflowMcp: WorkflowMcpStageContract;
};

export type StageHandoffDocument = {
  format: "heddle.stage-handoff";
  stage: {
    name: string;
  };
  taskContract: JsonValue;
  version: 1;
};
