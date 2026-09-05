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

export type NotificationFailureCategory =
  | "application-credential-rejected"
  | "legacy-intent-unverifiable"
  | "provider-quota-exceeded"
  | "recipient-rejected"
  | "request-rejected";

const notificationFailureCategories = new Set<NotificationFailureCategory>([
  "application-credential-rejected",
  "legacy-intent-unverifiable",
  "provider-quota-exceeded",
  "recipient-rejected",
  "request-rejected",
]);

export const isNotificationFailureCategory = (
  value: unknown,
): value is NotificationFailureCategory =>
  notificationFailureCategories.has(value as NotificationFailureCategory);

export interface NotificationFailureRecord {
  category: NotificationFailureCategory;
  occurrence: number;
  stableId: string;
  state: "rejected" | "retry-authorized";
}

export interface NotificationIntentFingerprint {
  attemptFingerprint: string;
  logicalFingerprint: string;
}

export interface ReconcilerRuntimeRecord {
  boardStatus: string;
  deferral?: JsonValue;
  instanceId: string;
  lifecycleRepositoryName?: string;
  provider?: string;
  sessionKey?: string;
  stageEnteredAt?: number;
  stageId?: string;
  state: "deferred" | "done" | "running" | "starting" | "waiting";
  taskId: number;
  threadId?: string;
}

export interface SessionRuntimeRecord {
  activation: number;
  instanceId: string;
  projectId?: string;
  repositoryName?: string;
  sessionKey: string;
  stageId: string;
  threadId: string;
}

export interface EpicProjectRecord {
  createCommandId: string;
  createdAt: string;
  deleteCommandId: string;
  epicId: number;
  productName: string;
  projectId: string;
  state: "active" | "creating" | "deleted" | "deleting";
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
