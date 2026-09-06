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

export type NotificationRetryCategory =
  | "invalid-response"
  | "network-failure"
  | "provider-unavailable"
  | "transport-failure";

const notificationRetryCategories = new Set<NotificationRetryCategory>([
  "invalid-response",
  "network-failure",
  "provider-unavailable",
  "transport-failure",
]);

export const isNotificationRetryCategory = (
  value: unknown,
): value is NotificationRetryCategory =>
  notificationRetryCategories.has(value as NotificationRetryCategory);

export interface NotificationFailureRecord {
  category: NotificationFailureCategory;
  message: string | null;
  occurrence: number;
  recipientLabel: string | null;
  stableId: string;
  state: "rejected" | "retry-authorized";
}

export interface NotificationVerification {
  message: string;
  recipientLabel: string;
}

export interface NotificationIntentFingerprint {
  attemptFingerprint: string;
  logicalFingerprint: string;
}

export interface NotificationRetryRecord {
  category: NotificationRetryCategory;
  retryNotBefore: number;
  stableId: string;
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

export type DynamicTaskKind = "finding" | "follow-up";

export interface DynamicTaskIntentRecord {
  completedAt?: string;
  kind: DynamicTaskKind;
  lifecycle: string;
  operationDigest: string;
  parentEpicId: number;
  recordDigest: string;
  recordedAt: string;
  request: JsonValue;
  sourceInstanceId: string;
  sourceSessionKey: string;
  sourceTaskId: number;
  state: "completed" | "pending";
  taskId?: number;
}

export type DynamicTaskIntentInput = Omit<
  DynamicTaskIntentRecord,
  "completedAt" | "recordedAt" | "state" | "taskId"
>;

export interface DynamicTaskIntentEvent {
  operationDigest: string;
  payload: JsonValue;
  recordedAt: string;
  sequence: number;
  type: "completed" | "pending";
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
