// ---
// relationships:
//   implements: heddle
// ---

import type { McpServer } from "@modelcontextprotocol/server";

import type {
  LifecycleBlueprint,
  LifecycleNode,
  LifecycleSnapshot,
} from "../engine/index.js";
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
  description: string;
  name: string;
}

export interface WorkflowMcpSessionBinding {
  blueprint: LifecycleBlueprint;
  dispositions: WorkflowMcpDisposition[];
  instance: InstanceRecord;
  sessionKey: string;
  stage: LifecycleNode;
  taskContext: JsonValue;
  token: string;
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
  repositoryRoot: string;
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
  sessionKey: string;
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
