// ---
// relationships:
//   implements: heddle
// ---

import type { McpServer } from "@modelcontextprotocol/server";

import type { LifecycleSnapshot } from "../engine/index.js";
import type {
  InstanceRecord,
  JsonValue,
  PersistedEvent,
} from "../persistence/index.js";

export interface WorkflowMcpPersistence {
  appendEvent(
    instanceId: string,
    type: string,
    payload: JsonValue,
  ): PersistedEvent;
  compareAndSwapInstance(
    instanceId: string,
    expectedVersion: number,
    state: InstanceRecord["state"],
  ): InstanceRecord | undefined;
  getInstance(instanceId: string): InstanceRecord | undefined;
  listInstances(): InstanceRecord[];
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
}

export interface WorkflowMcpSessionBinding {
  dispositions: WorkflowMcpDisposition[];
  instance: InstanceRecord;
  sessionKey: string;
  stage: { id: string; tools: string[] };
  taskContext: JsonValue;
  token: string;
}

export interface WorkflowMcpStageContract {
  [key: string]: JsonValue;
  blueprintBlobHash: string;
  blueprintPath: string;
  dispositions: WorkflowMcpDisposition[];
  stage: string;
  todoTemplate: string;
  tools: string[];
}

export interface WorkflowMcpToolContext {
  binding: WorkflowMcpSessionBinding;
  lifecycle: WorkflowMcpLifecycle;
  persistence: WorkflowMcpPersistence;
}

export interface WorkflowMcpToolContributor {
  name: string;
  register(server: McpServer, context: WorkflowMcpToolContext): void;
}

export interface WorkflowMcpHandlerOptions {
  lifecycle: WorkflowMcpLifecycle;
  persistence: WorkflowMcpPersistence;
  tools?: readonly WorkflowMcpToolContributor[];
}

export interface CorrelationTokenMatch {
  instance: InstanceRecord;
  sessionKey: string;
  token: string;
}

export type StoredStageHandoff = {
  [key: string]: JsonValue;
  correlationToken: string;
  handoff: string;
  kind: "stage-handoff";
  sessionKey: string;
  workflowMcp: WorkflowMcpStageContract;
};

export type StageHandoffDocument = {
  correlationToken: string;
  format: "heddle.stage-handoff";
  stage: {
    name: string;
  };
  taskContract: JsonValue;
  version: 1;
};
