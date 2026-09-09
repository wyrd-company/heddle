// ---
// relationships:
//   implements: heddle
// ---

import type { McpServer } from "@modelcontextprotocol/server";

import type {
  BoardRecordWriteResult,
  BoardTask,
  CreateBoardRecord,
} from "../board-adapter/index.js";
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

export interface StoredWorkflowMcpDisposition {
  [key: string]: JsonValue;
  description: string;
  name: string;
}

export interface WorkflowMcpDisposition extends StoredWorkflowMcpDisposition {
  outputContract: AdvanceOutputContract;
}

export interface WorkflowMcpSessionBinding {
  adjudication?: {
    escalationId: string;
    modelSlug: string;
    ownerSessionKey: string;
  };
  dispositions: WorkflowMcpDisposition[];
  instance: InstanceRecord;
  parentSessionKey?: string;
  sessionKey: string;
  stage: { id: string; skills: string[]; tools: string[] };
  taskContext: JsonValue;
  todoAssignment?: {
    listSessionKey: string;
    rootItemId: string;
  };
  token: string;
}

export interface StoredWorkflowMcpStageContract {
  [key: string]: JsonValue;
  blueprintBlobHash: string;
  blueprintPath: string;
  dispositions: StoredWorkflowMcpDisposition[];
  handoffTemplate: {
    commitSha: string;
    path: string;
  };
  skills: string[];
  stage: string;
  todoTemplate: string;
  tools: string[];
}

export interface WorkflowMcpStageContract extends StoredWorkflowMcpStageContract {
  dispositions: WorkflowMcpDisposition[];
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

export interface WorkflowMcpBoardAuthority {
  createRecord(
    record: CreateBoardRecord,
    source: {
      instanceId: string;
      sessionKey: string;
      taskId: number;
    },
  ): Promise<BoardRecordWriteResult>;
  readTask(taskId: number): Promise<BoardTask>;
}

export interface WorkflowMcpHandlerOptions {
  board?: WorkflowMcpBoardAuthority;
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
  workflowMcp: StoredWorkflowMcpStageContract;
};

export type StoredAdjudicationHandoff = {
  correlationToken: string;
  escalationId: string;
  handoff: string;
  kind: "adjudication-handoff";
  modelSlug: string;
  ownerSessionKey: string;
  sessionKey: string;
};

export type AdjudicationHandoffDocument = {
  context: JsonValue;
  decisionBoundary: string;
  format: "heddle.adjudication-handoff";
  policy: { blobHash: string; path: string };
  version: 1;
};

export type StageHandoffDocument = {
  format: "heddle.stage-handoff";
  stage: {
    name: string;
    skills: string[];
  };
  taskContract: JsonValue;
  version: 1;
};
