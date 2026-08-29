// ---
// relationships:
//   implements: heddle
// ---

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface InstanceState {
  correlationTokens: Record<string, string>;
  flowcraftContext: JsonValue;
  handoffs: JsonValue[];
  todoState: JsonValue;
}

export interface InstanceRecord {
  instanceId: string;
  state: InstanceState;
  version: number;
}

export interface PersistedEvent {
  instanceId: string;
  payload: JsonValue;
  recordedAt: string;
  sequence: number;
  type: string;
}

export interface InstanceEventClaim {
  event: PersistedEvent;
  record: InstanceRecord;
}

export interface PersistenceConfiguration {
  stateDirectory: string;
}

export interface DurableAttentionRecord {
  attentionId: string;
  payload: JsonValue;
  recordedAt: string;
}

export interface ReconcilerRuntimeRecord {
  boardStatus: string;
  deferral?: JsonValue;
  instanceId: string;
  provider?: string;
  sessionKey?: string;
  stageEnteredAt?: number;
  stageId?: string;
  state: "deferred" | "done" | "running" | "starting" | "waiting";
  taskId: number;
  threadId?: string;
}

export interface SessionRuntimeRecord {
  instanceId: string;
  sessionKey: string;
  stageId: string;
  threadId: string;
}

export type EventRow = {
  instance_id: string;
  payload_json: string;
  recorded_at: string;
  sequence: number;
  type: string;
};

export type InstanceRow = {
  instance_id: string;
  state_json: string;
  version: number;
};
