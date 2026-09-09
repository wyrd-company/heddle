// ---
// relationships:
//   implements: heddle
// ---

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { SqliteHistoryAdapter } from "@flowcraft/sqlite-history";
import Database from "better-sqlite3";

import {
  createSqliteFlowcraftHistory,
  type SqliteFlowcraftHistory,
} from "./sqlite-flowcraft-history.js";
import { parseEvent, parseState } from "./sqlite-event-row.js";
import { claimInstanceEvent } from "./sqlite-instance-event-claim.js";
import {
  deleteCorrelationTokenIndex,
  replaceCorrelationTokenIndex,
} from "./sqlite-correlation-token-index.js";
import {
  instanceCreatedEvent,
  instanceDeletedEvent,
  instanceUpdatedEvent,
  recoverInstances,
  stateEventTypes,
} from "./sqlite-instance-recovery.js";
import {
  assertResolvedSessionBinding,
  sameResolvedSessionBinding,
} from "./resolved-session-binding.js";
import {
  initializePersistenceSchema,
  protectFlowcraftHistory,
} from "./sqlite-schema.js";
import type {
  DurableAttentionRecord,
  DynamicTaskIntentEvent,
  DynamicTaskIntentInput,
  DynamicTaskIntentRecord,
  EpicProjectRecord,
  EventRow,
  InstanceEventClaim,
  IncidentAdmission,
  IncidentFailureObservation,
  IncidentRuntimeRecord,
  InstanceRecord,
  InstanceRow,
  InstanceState,
  JsonValue,
  NotificationFailureCategory,
  NotificationFailureRecord,
  NotificationIntentFingerprint,
  NotificationVerification,
  NotificationRetryCategory,
  NotificationRetryRecord,
  PersistedEvent,
  PersistenceConfiguration,
  ReconcilerRuntimeRecord,
  ResolvedSessionBinding,
  SchedulerPassFailureRecord,
  SchedulerPassHistoryRecord,
  SessionRuntimeRecord,
  SharedProjectRecord,
} from "./types.js";

const databaseFilename = "heddle-state.sqlite";

type DynamicTaskIntentRow = {
  completed_at: string | null;
  kind: DynamicTaskIntentRecord["kind"];
  lifecycle: string;
  operation_digest: string;
  parent_epic_id: number;
  record_digest: string;
  recorded_at: string;
  request_json: string;
  source_instance_id: string;
  source_session_key: string;
  source_task_id: number;
  state: DynamicTaskIntentRecord["state"];
  task_id: number | null;
};

type SchedulerPassHistoryRow = {
  episode: number;
  errorJson: string | null;
  recordedAt: string;
  sequence: number;
  type: SchedulerPassHistoryRecord["type"];
};

export class LegacyNotificationIntentMismatchError extends Error {
  public constructor() {
    super("Legacy notification intent cannot verify the current secure route");
    this.name = "LegacyNotificationIntentMismatchError";
  }
}
const serialize = (value: JsonValue | InstanceState): string => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Persistence values must be JSON serializable");
  }
  return serialized;
};

const parseResolvedSessionBinding = (
  serialized: string,
  sessionKey: string,
  threadId: string,
): ResolvedSessionBinding => {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error(`Session '${sessionKey}' has an invalid resolved binding`);
  }
  assertResolvedSessionBinding(value, sessionKey, threadId);
  return value;
};

export type FlowcraftHistory = SqliteFlowcraftHistory;

export class SqlitePersistence {
  readonly databasePath: string;
  readonly flowcraftHistory: FlowcraftHistory;

  private readonly database: Database.Database;
  private readonly flowcraftHistoryAdapter: SqliteHistoryAdapter;
  private closed = false;

  constructor(configuration: PersistenceConfiguration) {
    if (configuration.stateDirectory.trim() === "") {
      throw new TypeError("stateDirectory must not be empty");
    }

    mkdirSync(configuration.stateDirectory, { recursive: true });
    this.databasePath = join(configuration.stateDirectory, databaseFilename);
    this.database = new Database(this.databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("busy_timeout = 5000");
    initializePersistenceSchema(this.database);
    this.flowcraftHistoryAdapter = new SqliteHistoryAdapter({
      databasePath: this.databasePath,
      walMode: true,
    });
    protectFlowcraftHistory(this.database);
    this.flowcraftHistory = createSqliteFlowcraftHistory(
      this.database,
      this.flowcraftHistoryAdapter,
    );
    this.recoverInstances();
  }

  createInstance(instanceId: string, state: InstanceState): InstanceRecord {
    this.assertInstanceId(instanceId);
    const stateJson = serialize(state);

    return this.database.transaction(() => {
      if (this.instanceExists(instanceId)) {
        throw new Error(`Instance already exists: ${instanceId}`);
      }
      this.insertEvent(instanceId, instanceCreatedEvent, stateJson);
      this.database
        .prepare(
          `INSERT INTO heddle_instances (instance_id, state_json, version)
           VALUES (?, ?, 1)`,
        )
        .run(instanceId, stateJson);
      replaceCorrelationTokenIndex(
        this.database,
        instanceId,
        state.correlationTokens,
      );
      return this.getRequiredInstance(instanceId);
    })();
  }

  getInstance(instanceId: string): InstanceRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT instance_id, state_json, version
         FROM heddle_instances
         WHERE instance_id = ?`,
      )
      .get(instanceId) as InstanceRow | undefined;
    return row === undefined ? undefined : this.toInstanceRecord(row);
  }

  listInstances(): InstanceRecord[] {
    const rows = this.database
      .prepare(
        `SELECT instance_id, state_json, version
         FROM heddle_instances
         ORDER BY instance_id`,
      )
      .all() as InstanceRow[];
    return rows.map((row) => this.toInstanceRecord(row));
  }

  updateInstance(instanceId: string, state: InstanceState): InstanceRecord {
    const stateJson = serialize(state);

    return this.database.transaction(() => {
      const current = this.getRequiredInstance(instanceId);
      this.insertEvent(instanceId, instanceUpdatedEvent, stateJson);
      this.database
        .prepare(
          `UPDATE heddle_instances
           SET state_json = ?, version = ?
           WHERE instance_id = ?`,
        )
        .run(stateJson, current.version + 1, instanceId);
      replaceCorrelationTokenIndex(
        this.database,
        instanceId,
        state.correlationTokens,
      );
      return this.getRequiredInstance(instanceId);
    })();
  }

  compareAndSwapInstance(
    instanceId: string,
    expectedVersion: number,
    state: InstanceState,
  ): InstanceRecord | undefined {
    const stateJson = serialize(state);

    return this.database.transaction(() => {
      const result = this.database
        .prepare(
          `UPDATE heddle_instances
           SET state_json = ?, version = ?
           WHERE instance_id = ? AND version = ?`,
        )
        .run(stateJson, expectedVersion + 1, instanceId, expectedVersion);
      if (result.changes === 0) {
        this.getRequiredInstance(instanceId);
        return undefined;
      }
      replaceCorrelationTokenIndex(
        this.database,
        instanceId,
        state.correlationTokens,
      );
      this.insertEvent(instanceId, instanceUpdatedEvent, stateJson);
      return this.getRequiredInstance(instanceId);
    })();
  }

  compareAndSwapInstanceWithEvent(
    instanceId: string,
    expectedVersion: number,
    state: InstanceState,
    type: string,
    payload: JsonValue,
  ): InstanceEventClaim | undefined {
    this.assertExternalEventType(type);
    const stateJson = serialize(state);
    const payloadJson = serialize(payload);

    return this.database.transaction(() => {
      const claimed = claimInstanceEvent({
        appendEvent: () =>
          this.getEvent(this.insertEvent(instanceId, type, payloadJson)),
        claimVersion: () =>
          this.database
            .prepare(
              `UPDATE heddle_instances
               SET state_json = ?, version = ?
               WHERE instance_id = ? AND version = ?`,
            )
            .run(stateJson, expectedVersion + 1, instanceId, expectedVersion)
            .changes > 0,
        recordStateUpdate: () =>
          void this.insertEvent(instanceId, instanceUpdatedEvent, stateJson),
        requireRecord: () => this.getRequiredInstance(instanceId),
      });
      if (claimed !== undefined) {
        replaceCorrelationTokenIndex(
          this.database,
          instanceId,
          state.correlationTokens,
        );
      }
      return claimed;
    })();
  }

  deleteInstance(instanceId: string): void {
    this.database.transaction(() => {
      this.getRequiredInstance(instanceId);
      this.insertEvent(instanceId, instanceDeletedEvent, "null");
      this.database
        .prepare("DELETE FROM heddle_instances WHERE instance_id = ?")
        .run(instanceId);
      deleteCorrelationTokenIndex(this.database, instanceId);
    })();
  }

  appendEvent(
    instanceId: string,
    type: string,
    payload: JsonValue,
  ): PersistedEvent {
    this.assertExternalEventType(type);

    const payloadJson = serialize(payload);
    return this.database.transaction(() => {
      if (!this.instanceExists(instanceId)) {
        throw new Error(`Instance does not exist: ${instanceId}`);
      }
      const sequence = this.insertEvent(instanceId, type, payloadJson);
      return this.getEvent(sequence);
    })();
  }

  replayEvents(instanceId: string, afterSequence = 0): PersistedEvent[] {
    const rows = this.database
      .prepare(
        `SELECT sequence, instance_id, type, payload_json, recorded_at
         FROM heddle_instance_events
         WHERE instance_id = ? AND sequence > ?
         ORDER BY sequence`,
      )
      .all(instanceId, afterSequence) as EventRow[];
    return rows.map(parseEvent);
  }

  recoverInstances(): InstanceRecord[] {
    return recoverInstances(this.database);
  }

  hasAttention(attentionId: string): boolean {
    return (
      this.database
        .prepare("SELECT 1 FROM heddle_attention WHERE attention_id = ?")
        .get(attentionId) !== undefined
    );
  }

  raiseAttention(attentionId: string, payload: JsonValue): boolean {
    this.assertStableId("attentionId", attentionId);
    const payloadJson = serialize(payload);
    const inserted =
      this.database
        .prepare(
          `INSERT OR IGNORE INTO heddle_attention
             (attention_id, payload_json, recorded_at)
           VALUES (?, ?, ?)`,
        )
        .run(attentionId, payloadJson, new Date().toISOString()).changes > 0;
    if (inserted) return true;
    const prior = this.database
      .prepare(
        `SELECT payload_json AS payloadJson
         FROM heddle_attention
         WHERE attention_id = ?`,
      )
      .get(attentionId) as { payloadJson: string } | undefined;
    if (prior?.payloadJson !== payloadJson) {
      throw new Error(
        `Attention ${JSON.stringify(attentionId)} changed durable identity`,
      );
    }
    return false;
  }

  listAttention(): DurableAttentionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT attention_id, payload_json, recorded_at
         FROM heddle_attention
         WHERE resolved_at IS NULL
         ORDER BY recorded_at, attention_id`,
      )
      .all() as Array<{
      attention_id: string;
      payload_json: string;
      recorded_at: string;
    }>;
    return rows.map((row) => ({
      attentionId: row.attention_id,
      payload: JSON.parse(row.payload_json) as JsonValue,
      recordedAt: row.recorded_at,
    }));
  }

  getAttention(attentionId: string): DurableAttentionRecord | undefined {
    this.assertStableId("attentionId", attentionId);
    const row = this.database
      .prepare(
        `SELECT attention_id, payload_json, recorded_at, resolved_at,
                resolution_justification
         FROM heddle_attention
         WHERE attention_id = ?`,
      )
      .get(attentionId) as
      | {
          attention_id: string;
          payload_json: string;
          recorded_at: string;
          resolution_justification: string | null;
          resolved_at: string | null;
        }
      | undefined;
    return row === undefined
      ? undefined
      : {
          attentionId: row.attention_id,
          payload: JSON.parse(row.payload_json) as JsonValue,
          recordedAt: row.recorded_at,
          ...(row.resolution_justification === null
            ? {}
            : { resolutionJustification: row.resolution_justification }),
          ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
        };
  }

  resolveAttention(attentionId: string, justification?: string): boolean {
    this.assertStableId("attentionId", attentionId);
    if (justification !== undefined) {
      this.assertStableId("resolutionJustification", justification);
    }
    const resolved = this.database.transaction(() => {
      const changed =
        this.database
          .prepare(
            `UPDATE heddle_attention
           SET resolved_at = ?, resolution_justification = ?
           WHERE attention_id = ? AND resolved_at IS NULL`,
          )
          .run(new Date().toISOString(), justification ?? null, attentionId)
          .changes > 0;
      if (changed) {
        this.database
          .prepare(
            `DELETE FROM heddle_incident_admission WHERE attention_id = ?`,
          )
          .run(attentionId);
      }
      return changed;
    })();
    if (resolved) return true;
    if (this.hasAttention(attentionId)) return false;
    throw new Error(`Attention ${JSON.stringify(attentionId)} does not exist`);
  }

  reopenAttention(attentionId: string): boolean {
    this.assertStableId("attentionId", attentionId);
    const reopened =
      this.database
        .prepare(
          `UPDATE heddle_attention
           SET resolved_at = NULL, resolution_justification = NULL
           WHERE attention_id = ? AND resolved_at IS NOT NULL`,
        )
        .run(attentionId).changes > 0;
    if (reopened) return true;
    if (this.hasAttention(attentionId)) return false;
    throw new Error(`Attention ${JSON.stringify(attentionId)} does not exist`);
  }

  admitIncident(input: {
    attentionId: string;
    code: string;
    cooldownMilliseconds: number;
    createdAt: number;
    incidentId: string;
    maximumConcurrent: number;
    occurrence: number;
    sourceInstanceId?: string;
    taskId: number;
  }): IncidentAdmission {
    this.assertStableId("attentionId", input.attentionId);
    this.assertStableId("incidentId", input.incidentId);
    if (
      !Number.isSafeInteger(input.taskId) ||
      input.taskId <= 0 ||
      !Number.isSafeInteger(input.createdAt) ||
      input.createdAt < 0 ||
      !Number.isSafeInteger(input.cooldownMilliseconds) ||
      input.cooldownMilliseconds < 0 ||
      !Number.isSafeInteger(input.maximumConcurrent) ||
      input.maximumConcurrent <= 0 ||
      !Number.isSafeInteger(input.occurrence) ||
      input.occurrence <= 0
    ) {
      throw new TypeError("Incident admission bounds are invalid");
    }
    return this.database.transaction((): IncidentAdmission => {
      const runtimes = this.listIncidentRuntime();
      const conditionRuntimes = runtimes.filter(
        ({ attentionId }) => attentionId === input.attentionId,
      );
      const active = conditionRuntimes.filter(
        ({ state }) => state === "starting" || state === "waiting",
      );
      if (active.length > 1) {
        throw new Error("Incident condition has multiple active occurrences");
      }
      const existing = active[0];
      if (existing !== undefined) {
        if (
          existing.incidentId !== input.incidentId ||
          existing.occurrence !== input.occurrence ||
          existing.code !== input.code ||
          existing.taskId !== input.taskId ||
          existing.sourceInstanceId !== input.sourceInstanceId
        ) {
          throw new Error("Incident admission changed durable identity");
        }
        return { kind: "existing", runtime: existing };
      }
      const latestOccurrence = conditionRuntimes.reduce(
        (latest, runtime) => Math.max(latest, runtime.occurrence),
        0,
      );
      if (input.occurrence !== latestOccurrence + 1) {
        throw new Error("Incident admission occurrence is not next");
      }
      const priorConditionIdentity = conditionRuntimes.find(
        ({ code, sourceInstanceId, taskId }) =>
          code !== input.code ||
          sourceInstanceId !== input.sourceInstanceId ||
          taskId !== input.taskId,
      );
      if (priorConditionIdentity !== undefined) {
        throw new Error("Incident admission changed durable identity");
      }
      if (runtimes.some(({ incidentId }) => incidentId === input.incidentId)) {
        throw new Error("Incident admission changed durable identity");
      }
      const recent = this.database
        .prepare(
          `SELECT 1 FROM heddle_incident_runtime
           WHERE code = ? AND created_at > ?
           LIMIT 1`,
        )
        .get(input.code, input.createdAt - input.cooldownMilliseconds);
      if (recent !== undefined) {
        return { kind: "suppressed", reason: "per-code-cooldown" };
      }
      const activeCount = this.database
        .prepare(
          `SELECT count(*) AS count FROM heddle_incident_runtime
           WHERE state IN ('starting', 'waiting')`,
        )
        .get() as { count: number };
      if (activeCount.count >= input.maximumConcurrent) {
        return { kind: "suppressed", reason: "concurrency-cap" };
      }
      const runtime: IncidentRuntimeRecord = {
        accepted: false,
        attentionId: input.attentionId,
        code: input.code,
        createdAt: input.createdAt,
        incidentId: input.incidentId,
        occurrence: input.occurrence,
        rejectionOperationIds: [],
        ...(input.sourceInstanceId === undefined
          ? {}
          : { sourceInstanceId: input.sourceInstanceId }),
        state: "starting",
        taskId: input.taskId,
      };
      this.writeIncidentRuntime(runtime);
      return { kind: "admitted", runtime };
    })();
  }

  observeIncidentFailure(input: {
    attentionId: string;
    code: string;
    failureThreshold: number;
    observedAt: number;
    retryDelayMilliseconds: number;
    shortCircuit?: boolean;
  }): IncidentFailureObservation {
    this.assertStableId("attentionId", input.attentionId);
    this.assertStableId("code", input.code);
    if (
      !Number.isSafeInteger(input.failureThreshold) ||
      input.failureThreshold <= 0 ||
      !Number.isSafeInteger(input.observedAt) ||
      input.observedAt < 0 ||
      !Number.isSafeInteger(input.retryDelayMilliseconds) ||
      input.retryDelayMilliseconds < 0
    ) {
      throw new TypeError("Incident failure policy bounds are invalid");
    }
    return this.database.transaction((): IncidentFailureObservation => {
      const prior = this.database
        .prepare(
          `SELECT code, failure_count AS failureCount,
                  next_attempt_at AS nextAttemptAt, state
           FROM heddle_incident_admission
           WHERE attention_id = ?`,
        )
        .get(input.attentionId) as
        | {
            code: string;
            failureCount: number;
            nextAttemptAt: number;
            state: "closed" | "open";
          }
        | undefined;
      if (prior !== undefined && prior.code !== input.code) {
        throw new Error("Incident failure changed durable identity");
      }
      if (prior?.state === "open") {
        if (input.observedAt >= prior.nextAttemptAt) {
          this.database
            .prepare(
              `UPDATE heddle_incident_admission
               SET last_failure_at = ?, next_attempt_at = ?
               WHERE attention_id = ?`,
            )
            .run(
              input.observedAt,
              input.observedAt + input.retryDelayMilliseconds,
              input.attentionId,
            );
        }
        return { failureCount: prior.failureCount, kind: "breaker-open" };
      }
      if (
        prior !== undefined &&
        input.shortCircuit !== true &&
        input.observedAt < prior.nextAttemptAt
      ) {
        return {
          failureCount: prior.failureCount,
          kind: "retry-waiting",
          nextAttemptAt: prior.nextAttemptAt,
        };
      }
      const failureCount = (prior?.failureCount ?? 0) + 1;
      const open =
        input.shortCircuit === true || failureCount >= input.failureThreshold;
      const nextAttemptAt = input.observedAt + input.retryDelayMilliseconds;
      this.database
        .prepare(
          `INSERT INTO heddle_incident_admission
             (attention_id, code, failure_count, last_failure_at,
              next_attempt_at, state)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(attention_id) DO UPDATE SET
             failure_count = excluded.failure_count,
             last_failure_at = excluded.last_failure_at,
             next_attempt_at = excluded.next_attempt_at,
             state = excluded.state`,
        )
        .run(
          input.attentionId,
          input.code,
          failureCount,
          input.observedAt,
          nextAttemptAt,
          open ? "open" : "closed",
        );
      return open
        ? { failureCount, kind: "breaker-open" }
        : { failureCount, kind: "retry-scheduled", nextAttemptAt };
    })();
  }

  incidentFailureRetryReady(attentionId: string, observedAt: number): boolean {
    this.assertStableId("attentionId", attentionId);
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
      throw new TypeError("Incident failure observation time is invalid");
    }
    const admission = this.database
      .prepare(
        `SELECT next_attempt_at AS nextAttemptAt, state
         FROM heddle_incident_admission
         WHERE attention_id = ?`,
      )
      .get(attentionId) as
      { nextAttemptAt: number; state: "closed" | "open" } | undefined;
    return admission !== undefined && observedAt >= admission.nextAttemptAt;
  }

  listIncidentRuntime(): IncidentRuntimeRecord[] {
    const rows = this.database
      .prepare(
        `SELECT incident_id, attention_id, occurrence, code, task_id,
                source_instance_id, created_at, state, provider, stage_id,
                stage_entered_at, session_key, thread_id, diagnosis_json,
                accepted, rejection_operation_ids_json
         FROM heddle_incident_runtime
         ORDER BY created_at, attention_id, occurrence`,
      )
      .all() as Array<{
      accepted: number;
      attention_id: string;
      code: string;
      created_at: number;
      diagnosis_json: string | null;
      incident_id: string;
      occurrence: number;
      provider: string | null;
      rejection_operation_ids_json: string;
      session_key: string | null;
      source_instance_id: string | null;
      stage_entered_at: number | null;
      stage_id: string | null;
      state: IncidentRuntimeRecord["state"];
      task_id: number;
      thread_id: string | null;
    }>;
    return rows.map((row) => ({
      accepted: row.accepted === 1,
      attentionId: row.attention_id,
      code: row.code,
      createdAt: row.created_at,
      ...(row.diagnosis_json === null
        ? {}
        : { diagnosis: JSON.parse(row.diagnosis_json) as JsonValue }),
      incidentId: row.incident_id,
      occurrence: row.occurrence,
      ...(row.provider === null ? {} : { provider: row.provider }),
      rejectionOperationIds: JSON.parse(
        row.rejection_operation_ids_json,
      ) as string[],
      ...(row.session_key === null ? {} : { sessionKey: row.session_key }),
      ...(row.source_instance_id === null
        ? {}
        : { sourceInstanceId: row.source_instance_id }),
      ...(row.stage_entered_at === null
        ? {}
        : { stageEnteredAt: row.stage_entered_at }),
      ...(row.stage_id === null ? {} : { stageId: row.stage_id }),
      state: row.state,
      taskId: row.task_id,
      ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
    }));
  }

  writeIncidentRuntime(record: IncidentRuntimeRecord): void {
    this.assertStableId("incidentId", record.incidentId);
    if (!Number.isSafeInteger(record.occurrence) || record.occurrence <= 0) {
      throw new TypeError(
        "Incident occurrence must be a positive safe integer",
      );
    }
    const runtimes = this.listIncidentRuntime();
    const prior = runtimes.find(
      ({ incidentId }) => incidentId === record.incidentId,
    );
    if (
      prior !== undefined &&
      (prior.attentionId !== record.attentionId ||
        prior.code !== record.code ||
        prior.createdAt !== record.createdAt ||
        prior.occurrence !== record.occurrence ||
        prior.sourceInstanceId !== record.sourceInstanceId ||
        prior.taskId !== record.taskId)
    ) {
      throw new Error("Incident runtime changed durable identity");
    }
    const occurrence = runtimes.find(
      ({ attentionId, occurrence }) =>
        attentionId === record.attentionId && occurrence === record.occurrence,
    );
    if (
      occurrence !== undefined &&
      occurrence.incidentId !== record.incidentId
    ) {
      throw new Error("Incident runtime changed durable occurrence identity");
    }
    this.database
      .prepare(
        `INSERT INTO heddle_incident_runtime
           (incident_id, attention_id, occurrence, code, task_id,
            source_instance_id, created_at, state, provider, stage_id,
            stage_entered_at, session_key, thread_id, diagnosis_json,
            accepted, rejection_operation_ids_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(incident_id) DO UPDATE SET
           state = excluded.state,
           provider = excluded.provider,
           stage_id = excluded.stage_id,
           stage_entered_at = excluded.stage_entered_at,
           session_key = excluded.session_key,
           thread_id = excluded.thread_id,
           diagnosis_json = excluded.diagnosis_json,
           accepted = excluded.accepted,
           rejection_operation_ids_json = excluded.rejection_operation_ids_json`,
      )
      .run(
        record.incidentId,
        record.attentionId,
        record.occurrence,
        record.code,
        record.taskId,
        record.sourceInstanceId ?? null,
        record.createdAt,
        record.state,
        record.provider ?? null,
        record.stageId ?? null,
        record.stageEnteredAt ?? null,
        record.sessionKey ?? null,
        record.threadId ?? null,
        record.diagnosis === undefined ? null : serialize(record.diagnosis),
        record.accepted ? 1 : 0,
        serialize(record.rejectionOperationIds),
      );
  }

  writeStartingIncidentSessionRuntime(
    runtime: IncidentRuntimeRecord,
    session: SessionRuntimeRecord,
  ): void {
    if (
      runtime.state !== "starting" ||
      runtime.incidentId !== session.instanceId ||
      runtime.sessionKey !== session.sessionKey ||
      runtime.stageId !== session.stageId ||
      runtime.threadId !== session.threadId
    ) {
      throw new Error(
        "Starting incident runtime and resolved session binding identify different occurrences",
      );
    }
    this.database.transaction(() => {
      this.writeSessionRuntime(session);
      this.writeIncidentRuntime(runtime);
    })();
  }

  effectCompleted(effectKind: string, stableId: string): boolean {
    this.assertStableId("effectKind", effectKind);
    this.assertStableId("stableId", stableId);
    return (
      this.database
        .prepare(
          `SELECT 1 FROM heddle_completed_effects
           WHERE effect_kind = ? AND stable_id = ? AND state = 'completed'`,
        )
        .get(effectKind, stableId) !== undefined
    );
  }

  admitProductionErrorPage(input: {
    attentionId: string;
    attemptedAt: number;
    code: string;
    cooldownMilliseconds: number;
    maximumPagesPerWindow: number;
    windowMilliseconds: number;
  }): boolean {
    this.assertStableId("attentionId", input.attentionId);
    this.assertStableId("code", input.code);
    for (const name of [
      "attemptedAt",
      "cooldownMilliseconds",
      "maximumPagesPerWindow",
      "windowMilliseconds",
    ] as const) {
      if (!Number.isSafeInteger(input[name]) || input[name] < 0) {
        throw new TypeError(`${name} must be a non-negative safe integer`);
      }
    }
    if (
      input.cooldownMilliseconds === 0 ||
      input.maximumPagesPerWindow === 0 ||
      input.windowMilliseconds === 0
    ) {
      throw new TypeError("Production error page policy must be positive");
    }
    return this.database.transaction(() => {
      const windowStart = input.attemptedAt - input.windowMilliseconds;
      this.database
        .prepare(
          `DELETE FROM heddle_production_error_page_attempts
           WHERE attempted_at <= ?`,
        )
        .run(windowStart);
      const existing = this.database
        .prepare(
          `SELECT 1 FROM heddle_production_error_page_attempts
           WHERE code = ? AND attention_id = ?`,
        )
        .get(input.code, input.attentionId);
      if (existing !== undefined) return false;
      const window = this.database
        .prepare(
          `SELECT COUNT(*) AS attempts, MAX(attempted_at) AS lastAttemptAt
           FROM heddle_production_error_page_attempts
           WHERE code = ?`,
        )
        .get(input.code) as { attempts: number; lastAttemptAt: number | null };
      if (
        window.attempts >= input.maximumPagesPerWindow ||
        (window.lastAttemptAt !== null &&
          input.attemptedAt - window.lastAttemptAt < input.cooldownMilliseconds)
      ) {
        return false;
      }
      this.database
        .prepare(
          `INSERT INTO heddle_production_error_page_attempts
             (code, attention_id, attempted_at, delivery_attempted)
           VALUES (?, ?, ?, 0)`,
        )
        .run(input.code, input.attentionId, input.attemptedAt);
      return true;
    })();
  }

  claimProductionErrorPageDelivery(code: string, attentionId: string): boolean {
    this.assertStableId("code", code);
    this.assertStableId("attentionId", attentionId);
    return (
      this.database
        .prepare(
          `UPDATE heddle_production_error_page_attempts
           SET delivery_attempted = 1
           WHERE code = ? AND attention_id = ? AND delivery_attempted = 0`,
        )
        .run(code, attentionId).changes > 0
    );
  }

  productionErrorPageAttemptRecorded(
    code: string,
    attentionId: string,
  ): boolean {
    this.assertStableId("code", code);
    this.assertStableId("attentionId", attentionId);
    return (
      this.database
        .prepare(
          `SELECT 1 FROM heddle_production_error_page_attempts
           WHERE code = ? AND attention_id = ?`,
        )
        .get(code, attentionId) !== undefined
    );
  }

  recordSchedulerPassFailure(error: JsonValue): SchedulerPassFailureRecord {
    const errorJson = serialize(error);
    return this.database.transaction(() => {
      const latest = this.latestSchedulerPassHistory();
      const episode =
        latest === undefined
          ? 1
          : latest.type === "failure"
            ? latest.episode
            : latest.episode + 1;
      const event = this.insertSchedulerPassHistory(
        episode,
        "failure",
        errorJson,
      );
      return {
        ...event,
        episodeFirstError: this.firstSchedulerPassFailure(episode),
        error,
        type: "failure" as const,
      };
    })();
  }

  recoverSchedulerPass(
    attentionIds: readonly string[],
  ): SchedulerPassHistoryRecord | undefined {
    const uniqueAttentionIds = [...new Set(attentionIds)];
    for (const attentionId of uniqueAttentionIds) {
      this.assertStableId("attentionId", attentionId);
    }
    return this.database.transaction(() => {
      const latest = this.latestSchedulerPassHistory();
      const resolvedAt = new Date().toISOString();
      const resolve = this.database.prepare(
        `UPDATE heddle_attention
         SET resolved_at = ?
         WHERE attention_id = ? AND resolved_at IS NULL`,
      );
      for (const attentionId of uniqueAttentionIds) {
        resolve.run(resolvedAt, attentionId);
      }
      if (latest === undefined || latest.type === "recovery") {
        return undefined;
      }
      return this.insertSchedulerPassHistory(latest.episode, "recovery", null);
    })();
  }

  listSchedulerPassHistory(): SchedulerPassHistoryRecord[] {
    const rows = this.database
      .prepare(
        `SELECT sequence, episode, type, error_json AS errorJson,
                recorded_at AS recordedAt
         FROM heddle_scheduler_pass_history
         ORDER BY sequence`,
      )
      .all() as SchedulerPassHistoryRow[];
    return rows.map((row) => this.toSchedulerPassHistory(row));
  }

  currentSchedulerPassFailureSequence(): number | undefined {
    const latest = this.latestSchedulerPassHistory();
    return latest?.type === "failure" ? latest.sequence : undefined;
  }

  effectIntentRecorded(effectKind: string, stableId: string): boolean {
    this.assertStableId("effectKind", effectKind);
    this.assertStableId("stableId", stableId);
    return (
      this.database
        .prepare(
          `SELECT 1 FROM heddle_completed_effects
           WHERE effect_kind = ? AND stable_id = ?`,
        )
        .get(effectKind, stableId) !== undefined
    );
  }

  recordEffectIntent(
    effectKind: string,
    stableId: string,
    payload: JsonValue = null,
  ): boolean {
    this.assertStableId("effectKind", effectKind);
    this.assertStableId("stableId", stableId);
    const payloadJson = serialize(payload);
    const inserted =
      this.database
        .prepare(
          `INSERT OR IGNORE INTO heddle_completed_effects
             (effect_kind, stable_id, state, payload_json, recorded_at, completed_at)
           VALUES (?, ?, 'pending', ?, ?, NULL)`,
        )
        .run(effectKind, stableId, payloadJson, new Date().toISOString())
        .changes > 0;
    if (inserted) return true;
    const prior = this.database
      .prepare(
        `SELECT payload_json AS payloadJson
         FROM heddle_completed_effects
         WHERE effect_kind = ? AND stable_id = ?`,
      )
      .get(effectKind, stableId) as { payloadJson: string } | undefined;
    if (prior?.payloadJson !== payloadJson) {
      throw new Error(
        `Effect ${JSON.stringify([effectKind, stableId])} changed durable identity`,
      );
    }
    return false;
  }

  recordNotificationIntent(
    stableId: string,
    fingerprint: NotificationIntentFingerprint,
    legacyFingerprint: string,
    equivalentFingerprints: readonly NotificationIntentFingerprint[] = [],
  ): boolean {
    this.assertStableId("stableId", stableId);
    const effectKind = "pushover";
    const payloadJson = serialize({
      attemptFingerprint: fingerprint.attemptFingerprint,
      logicalFingerprint: fingerprint.logicalFingerprint,
    });
    const inserted =
      this.database
        .prepare(
          `INSERT OR IGNORE INTO heddle_completed_effects
             (effect_kind, stable_id, state, payload_json, recorded_at, completed_at)
           VALUES (?, ?, 'pending', ?, ?, NULL)`,
        )
        .run(effectKind, stableId, payloadJson, new Date().toISOString())
        .changes > 0;
    if (inserted) return true;
    const prior = this.database
      .prepare(
        `SELECT payload_json AS payloadJson
         FROM heddle_completed_effects
         WHERE effect_kind = ? AND stable_id = ?`,
      )
      .get(effectKind, stableId) as { payloadJson: string } | undefined;
    if (prior?.payloadJson === payloadJson) return false;
    if (
      equivalentFingerprints.some(
        (equivalent) =>
          prior?.payloadJson ===
          serialize({
            attemptFingerprint: equivalent.attemptFingerprint,
            logicalFingerprint: equivalent.logicalFingerprint,
          }),
      )
    ) {
      this.database
        .prepare(
          `UPDATE heddle_completed_effects
           SET payload_json = ?
           WHERE effect_kind = ? AND stable_id = ? AND state = 'pending'`,
        )
        .run(payloadJson, effectKind, stableId);
      return false;
    }
    let priorPayload: unknown;
    try {
      priorPayload = JSON.parse(prior?.payloadJson ?? "null");
    } catch {
      priorPayload = null;
    }
    const legacyMatches =
      typeof priorPayload === "object" &&
      priorPayload !== null &&
      !Array.isArray(priorPayload) &&
      (priorPayload as Record<string, unknown>)["messageFingerprint"] ===
        legacyFingerprint;
    const legacyIntent =
      typeof priorPayload === "object" &&
      priorPayload !== null &&
      !Array.isArray(priorPayload) &&
      typeof (priorPayload as Record<string, unknown>)["messageFingerprint"] ===
        "string";
    const sameLogicalIntent =
      typeof priorPayload === "object" &&
      priorPayload !== null &&
      !Array.isArray(priorPayload) &&
      (priorPayload as Record<string, unknown>)["logicalFingerprint"] ===
        fingerprint.logicalFingerprint;
    const failureState = this.notificationFailure(stableId)?.state;
    if (sameLogicalIntent && failureState === "rejected") return false;
    const retryAuthorized = failureState === "retry-authorized";
    if (legacyIntent && !legacyMatches && !retryAuthorized) {
      throw new LegacyNotificationIntentMismatchError();
    }
    if (
      !legacyMatches &&
      !(retryAuthorized && (sameLogicalIntent || legacyIntent))
    ) {
      throw new Error(
        `Effect ${JSON.stringify([effectKind, stableId])} changed durable identity`,
      );
    }
    this.database
      .prepare(
        `UPDATE heddle_completed_effects
         SET payload_json = ?
         WHERE effect_kind = ? AND stable_id = ?`,
      )
      .run(payloadJson, effectKind, stableId);
    return false;
  }

  notificationFailure(stableId: string): NotificationFailureRecord | undefined {
    this.assertStableId("stableId", stableId);
    const row = this.database
      .prepare(
        `SELECT stable_id AS stableId, occurrence, category,
                recipient_label AS recipientLabel, message, state
         FROM heddle_notification_failures
         WHERE stable_id = ?`,
      )
      .get(stableId) as NotificationFailureRecord | undefined;
    return row;
  }

  recordNotificationFailure(
    stableId: string,
    category: NotificationFailureCategory,
    verification?: NotificationVerification,
  ): NotificationFailureRecord {
    this.assertStableId("stableId", stableId);
    if (
      verification !== undefined &&
      (verification.recipientLabel.trim() === "" ||
        verification.message.trim() === "")
    ) {
      throw new TypeError(
        "notification verification recipientLabel and message must not be empty",
      );
    }
    this.database
      .prepare(
        `INSERT INTO heddle_notification_failures
           (stable_id, occurrence, category, recipient_label, message, state, recorded_at)
         VALUES (?, 1, ?, ?, ?, 'rejected', ?)
         ON CONFLICT(stable_id) DO UPDATE SET
           occurrence = CASE
             WHEN state = 'retry-authorized' THEN occurrence + 1
             ELSE occurrence
           END,
           category = excluded.category,
           recipient_label = CASE
             WHEN state = 'retry-authorized' THEN excluded.recipient_label
             ELSE COALESCE(recipient_label, excluded.recipient_label)
           END,
           message = CASE
             WHEN state = 'retry-authorized' THEN excluded.message
             ELSE COALESCE(message, excluded.message)
           END,
           state = 'rejected',
           recorded_at = excluded.recorded_at`,
      )
      .run(
        stableId,
        category,
        verification?.recipientLabel ?? null,
        verification?.message ?? null,
        new Date().toISOString(),
      );
    return this.notificationFailure(stableId)!;
  }

  notificationRetry(stableId: string): NotificationRetryRecord | undefined {
    this.assertStableId("stableId", stableId);
    return this.database
      .prepare(
        `SELECT stable_id AS stableId, category,
                retry_not_before AS retryNotBefore
         FROM heddle_notification_retries
         WHERE stable_id = ?`,
      )
      .get(stableId) as NotificationRetryRecord | undefined;
  }

  recordNotificationRetry(
    stableId: string,
    category: NotificationRetryCategory,
    retryNotBefore: number,
  ): NotificationRetryRecord {
    this.assertStableId("stableId", stableId);
    if (!Number.isSafeInteger(retryNotBefore) || retryNotBefore < 0) {
      throw new TypeError("retryNotBefore must be a non-negative safe integer");
    }
    this.database
      .prepare(
        `INSERT INTO heddle_notification_retries
           (stable_id, category, retry_not_before)
         VALUES (?, ?, ?)
         ON CONFLICT(stable_id) DO UPDATE SET
           category = excluded.category,
           retry_not_before = excluded.retry_not_before`,
      )
      .run(stableId, category, retryNotBefore);
    return this.notificationRetry(stableId)!;
  }

  clearNotificationRetry(stableId: string): boolean {
    this.assertStableId("stableId", stableId);
    return (
      this.database
        .prepare(`DELETE FROM heddle_notification_retries WHERE stable_id = ?`)
        .run(stableId).changes > 0
    );
  }

  authorizeNotificationRetry(stableId: string, occurrence: number): boolean {
    this.assertStableId("stableId", stableId);
    if (!Number.isSafeInteger(occurrence) || occurrence <= 0) {
      throw new TypeError("occurrence must be a positive safe integer");
    }
    return (
      this.database
        .prepare(
          `UPDATE heddle_notification_failures
           SET state = 'retry-authorized'
           WHERE stable_id = ? AND occurrence = ? AND state = 'rejected'`,
        )
        .run(stableId, occurrence).changes > 0
    );
  }

  recordEffectCompleted(effectKind: string, stableId: string): boolean {
    this.assertStableId("effectKind", effectKind);
    this.assertStableId("stableId", stableId);
    return (
      this.database
        .prepare(
          `UPDATE heddle_completed_effects
           SET state = 'completed', completed_at = ?
           WHERE effect_kind = ? AND stable_id = ? AND state = 'pending'`,
        )
        .run(new Date().toISOString(), effectKind, stableId).changes > 0
    );
  }

  getEpicProject(epicId: number): EpicProjectRecord | undefined {
    this.assertTaskId("epicId", epicId);
    return this.database
      .prepare(
        `SELECT epic_id AS epicId, product_name AS productName,
                project_id AS projectId,
                CASE WHEN deleted = 1 THEN 'deleted' ELSE state END AS state,
                create_command_id AS createCommandId,
                created_at AS createdAt,
                delete_command_id AS deleteCommandId
         FROM heddle_epic_projects
         WHERE epic_id = ?`,
      )
      .get(epicId) as EpicProjectRecord | undefined;
  }

  listEpicProjects(): EpicProjectRecord[] {
    return this.database
      .prepare(
        `SELECT epic_id AS epicId, product_name AS productName,
                project_id AS projectId,
                CASE WHEN deleted = 1 THEN 'deleted' ELSE state END AS state,
                create_command_id AS createCommandId,
                created_at AS createdAt,
                delete_command_id AS deleteCommandId
         FROM heddle_epic_projects
         ORDER BY epic_id`,
      )
      .all() as EpicProjectRecord[];
  }

  writeEpicProject(record: EpicProjectRecord): void {
    this.assertTaskId("epicId", record.epicId);
    for (const name of [
      "productName",
      "projectId",
      "createCommandId",
      "createdAt",
      "deleteCommandId",
    ] as const) {
      this.assertStableId(name, record[name]);
    }
    const prior = this.getEpicProject(record.epicId);
    if (
      prior !== undefined &&
      (prior.productName !== record.productName ||
        prior.projectId !== record.projectId ||
        prior.createCommandId !== record.createCommandId ||
        prior.createdAt !== record.createdAt ||
        prior.deleteCommandId !== record.deleteCommandId)
    ) {
      throw new Error(`Epic ${record.epicId} changed durable project identity`);
    }
    if (prior?.state === "deleted" && record.state !== "deleted") {
      throw new Error(`Epic ${record.epicId} project deletion is terminal`);
    }
    const storedState = record.state === "deleted" ? "deleting" : record.state;
    this.database
      .prepare(
        `INSERT INTO heddle_epic_projects
           (epic_id, product_name, project_id, state, deleted,
            create_command_id, created_at, delete_command_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(epic_id) DO UPDATE SET
           state = excluded.state,
           deleted = excluded.deleted`,
      )
      .run(
        record.epicId,
        record.productName,
        record.projectId,
        storedState,
        record.state === "deleted" ? 1 : 0,
        record.createCommandId,
        record.createdAt,
        record.deleteCommandId,
      );
  }

  getSharedProject(): SharedProjectRecord | undefined {
    return this.database
      .prepare(
        `SELECT project_name AS projectName, project_id AS projectId,
                workspace_root AS workspaceRoot, state,
                create_command_id AS createCommandId, created_at AS createdAt
         FROM heddle_shared_project
         WHERE singleton = 1`,
      )
      .get() as SharedProjectRecord | undefined;
  }

  writeSharedProject(record: SharedProjectRecord): void {
    for (const name of [
      "projectName",
      "projectId",
      "workspaceRoot",
      "createCommandId",
      "createdAt",
    ] as const) {
      this.assertStableId(name, record[name]);
    }
    const prior = this.getSharedProject();
    if (
      prior !== undefined &&
      (prior.projectName !== record.projectName ||
        prior.projectId !== record.projectId ||
        prior.workspaceRoot !== record.workspaceRoot ||
        prior.createCommandId !== record.createCommandId ||
        prior.createdAt !== record.createdAt)
    ) {
      throw new Error("The shared project changed durable identity");
    }
    this.database
      .prepare(
        `INSERT INTO heddle_shared_project
           (singleton, project_name, project_id, workspace_root, state,
            create_command_id, created_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET state = excluded.state`,
      )
      .run(
        record.projectName,
        record.projectId,
        record.workspaceRoot,
        record.state,
        record.createCommandId,
        record.createdAt,
      );
  }

  recordDynamicTaskIntent(input: DynamicTaskIntentInput): {
    record: DynamicTaskIntentRecord;
    replayed: boolean;
  } {
    this.assertDigest("operationDigest", input.operationDigest);
    this.assertDigest("recordDigest", input.recordDigest);
    this.assertTaskId("sourceTaskId", input.sourceTaskId);
    this.assertTaskId("parentEpicId", input.parentEpicId);
    this.assertStableId("sourceInstanceId", input.sourceInstanceId);
    this.assertStableId("sourceSessionKey", input.sourceSessionKey);
    this.assertStableId("lifecycle", input.lifecycle);
    const requestJson = serialize(input.request);

    return this.database.transaction(() => {
      const recordedAt = new Date().toISOString();
      const inserted =
        this.database
          .prepare(
            `INSERT OR IGNORE INTO heddle_dynamic_task_intents
               (operation_digest, record_digest, source_task_id,
                source_instance_id, source_session_key, kind, parent_epic_id,
                lifecycle, request_json, state, task_id, recorded_at,
                completed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
          )
          .run(
            input.operationDigest,
            input.recordDigest,
            input.sourceTaskId,
            input.sourceInstanceId,
            input.sourceSessionKey,
            input.kind,
            input.parentEpicId,
            input.lifecycle,
            requestJson,
            recordedAt,
          ).changes > 0;
      if (inserted) {
        this.insertDynamicTaskIntentEvent(
          input.operationDigest,
          "pending",
          serialize({ ...input, state: "pending" }),
          recordedAt,
        );
      }
      const record = this.getRequiredDynamicTaskIntent(input.operationDigest);
      if (!this.sameDynamicTaskIntent(input, requestJson, record)) {
        throw new Error(
          `Dynamic task operation '${input.operationDigest}' changed durable identity`,
        );
      }
      return { record, replayed: !inserted };
    })();
  }

  completeDynamicTaskIntent(
    operationDigest: string,
    taskId: number,
  ): DynamicTaskIntentRecord {
    this.assertDigest("operationDigest", operationDigest);
    this.assertTaskId("taskId", taskId);
    return this.database.transaction(() => {
      const prior = this.getRequiredDynamicTaskIntent(operationDigest);
      if (prior.state === "completed") {
        if (prior.taskId !== taskId) {
          throw new Error(
            `Dynamic task operation '${operationDigest}' changed task identity`,
          );
        }
        return prior;
      }
      const completedAt = new Date().toISOString();
      this.database
        .prepare(
          `UPDATE heddle_dynamic_task_intents
           SET state = 'completed', task_id = ?, completed_at = ?
           WHERE operation_digest = ? AND state = 'pending'`,
        )
        .run(taskId, completedAt, operationDigest);
      this.insertDynamicTaskIntentEvent(
        operationDigest,
        "completed",
        serialize({ taskId }),
        completedAt,
      );
      return this.getRequiredDynamicTaskIntent(operationDigest);
    })();
  }

  getDynamicTaskIntent(
    operationDigest: string,
  ): DynamicTaskIntentRecord | undefined {
    this.assertDigest("operationDigest", operationDigest);
    const row = this.database
      .prepare(
        `SELECT operation_digest, record_digest, source_task_id,
                source_instance_id, source_session_key, kind, parent_epic_id,
                lifecycle, request_json, state, task_id, recorded_at,
                completed_at
         FROM heddle_dynamic_task_intents
         WHERE operation_digest = ?`,
      )
      .get(operationDigest);
    return row === undefined
      ? undefined
      : this.toDynamicTaskIntent(row as DynamicTaskIntentRow);
  }

  listDynamicTaskIntents(
    state?: DynamicTaskIntentRecord["state"],
  ): DynamicTaskIntentRecord[] {
    const rows = this.database
      .prepare(
        `SELECT operation_digest, record_digest, source_task_id,
                source_instance_id, source_session_key, kind, parent_epic_id,
                lifecycle, request_json, state, task_id, recorded_at,
                completed_at
         FROM heddle_dynamic_task_intents
         ${state === undefined ? "" : "WHERE state = ?"}
         ORDER BY recorded_at, operation_digest`,
      )
      .all(...(state === undefined ? [] : [state])) as DynamicTaskIntentRow[];
    return rows.map((row) => this.toDynamicTaskIntent(row));
  }

  replayDynamicTaskIntentEvents(
    operationDigest: string,
  ): DynamicTaskIntentEvent[] {
    this.assertDigest("operationDigest", operationDigest);
    const rows = this.database
      .prepare(
        `SELECT sequence, operation_digest, type, payload_json, recorded_at
         FROM heddle_dynamic_task_intent_events
         WHERE operation_digest = ?
         ORDER BY sequence`,
      )
      .all(operationDigest) as Array<{
      operation_digest: string;
      payload_json: string;
      recorded_at: string;
      sequence: number;
      type: DynamicTaskIntentEvent["type"];
    }>;
    return rows.map((row) => ({
      operationDigest: row.operation_digest,
      payload: JSON.parse(row.payload_json) as JsonValue,
      recordedAt: row.recorded_at,
      sequence: row.sequence,
      type: row.type,
    }));
  }

  listReconcilerRuntime(): ReconcilerRuntimeRecord[] {
    const rows = this.database
      .prepare(
        `SELECT instance_id, task_id, board_status, state, provider,
                lifecycle_repository_name,
                deferral_json, stage_id, stage_entered_at, session_key, thread_id
         FROM heddle_reconciler_runtime
         ORDER BY task_id`,
      )
      .all() as Array<{
      board_status: string;
      deferral_json: string | null;
      instance_id: string;
      lifecycle_repository_name: string | null;
      provider: string | null;
      session_key: string | null;
      stage_entered_at: number | null;
      stage_id: string | null;
      state: ReconcilerRuntimeRecord["state"];
      task_id: number;
      thread_id: string | null;
    }>;
    return rows.map((row) => ({
      boardStatus: row.board_status,
      ...(row.deferral_json === null
        ? {}
        : { deferral: JSON.parse(row.deferral_json) as JsonValue }),
      instanceId: row.instance_id,
      ...(row.lifecycle_repository_name === null
        ? {}
        : { lifecycleRepositoryName: row.lifecycle_repository_name }),
      ...(row.provider === null ? {} : { provider: row.provider }),
      ...(row.session_key === null ? {} : { sessionKey: row.session_key }),
      ...(row.stage_entered_at === null
        ? {}
        : { stageEnteredAt: row.stage_entered_at }),
      ...(row.stage_id === null ? {} : { stageId: row.stage_id }),
      state: row.state,
      taskId: row.task_id,
      ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
    }));
  }

  writeReconcilerRuntime(record: ReconcilerRuntimeRecord): void {
    this.assertInstanceId(record.instanceId);
    this.database
      .prepare(
        `INSERT INTO heddle_reconciler_runtime
           (instance_id, task_id, board_status, state, provider,
            lifecycle_repository_name, deferral_json, stage_id,
            stage_entered_at, session_key, thread_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET
           task_id = excluded.task_id,
           board_status = excluded.board_status,
           state = excluded.state,
           provider = excluded.provider,
           lifecycle_repository_name = excluded.lifecycle_repository_name,
           deferral_json = excluded.deferral_json,
           stage_id = excluded.stage_id,
           stage_entered_at = excluded.stage_entered_at,
           session_key = excluded.session_key,
           thread_id = excluded.thread_id`,
      )
      .run(
        record.instanceId,
        record.taskId,
        record.boardStatus,
        record.state,
        record.provider ?? null,
        record.lifecycleRepositoryName ?? null,
        record.deferral === undefined ? null : serialize(record.deferral),
        record.stageId ?? null,
        record.stageEnteredAt ?? null,
        record.sessionKey ?? null,
        record.threadId ?? null,
      );
  }

  writeStartingSessionRuntime(
    runtime: ReconcilerRuntimeRecord,
    session: SessionRuntimeRecord,
  ): void {
    if (
      runtime.state !== "starting" ||
      runtime.instanceId !== session.instanceId ||
      runtime.sessionKey !== session.sessionKey ||
      runtime.stageId !== session.stageId ||
      runtime.threadId !== session.threadId
    ) {
      throw new Error(
        "Starting runtime and resolved session binding identify different occurrences",
      );
    }
    this.database.transaction(() => {
      this.writeSessionRuntime(session);
      this.writeReconcilerRuntime(runtime);
    })();
  }

  listSessionRuntime(): SessionRuntimeRecord[] {
    const rows = this.database
      .prepare(
        `SELECT activation, binding_json AS bindingJson,
                instance_id AS instanceId, project_id AS projectId,
                repository_name AS repositoryName, session_key AS sessionKey,
                stage_id AS stageId, thread_id AS threadId
         FROM heddle_session_runtime
         ORDER BY instance_id, stage_id, activation`,
      )
      .all() as Array<
      Omit<SessionRuntimeRecord, "binding" | "projectId" | "repositoryName"> & {
        bindingJson: string | null;
        projectId: string | null;
        repositoryName: string | null;
      }
    >;
    return rows.map(({ bindingJson, projectId, repositoryName, ...row }) => {
      if (bindingJson === null) {
        throw new Error(
          `Session '${row.sessionKey}' predates resolved session bindings; clear the pre-release state directory before restart`,
        );
      }
      const binding = parseResolvedSessionBinding(
        bindingJson,
        row.sessionKey,
        row.threadId,
      );
      return {
        ...row,
        binding,
        ...(projectId === null ? {} : { projectId }),
        ...(repositoryName === null ? {} : { repositoryName }),
      };
    });
  }

  writeSessionRuntime(record: SessionRuntimeRecord): void {
    if (!Number.isSafeInteger(record.activation) || record.activation < 1) {
      throw new TypeError("activation must be a positive safe integer");
    }
    for (const name of [
      "instanceId",
      "sessionKey",
      "stageId",
      "threadId",
    ] as const) {
      this.assertStableId(name, record[name]);
    }
    if (record.projectId !== undefined) {
      this.assertStableId("projectId", record.projectId);
    }
    if (record.repositoryName !== undefined) {
      this.assertStableId("repositoryName", record.repositoryName);
    }
    assertResolvedSessionBinding(
      record.binding,
      record.sessionKey,
      record.threadId,
    );
    const priorRow = this.database
      .prepare(
        `SELECT activation, binding_json AS bindingJson,
                instance_id AS instanceId, project_id AS projectId,
                repository_name AS repositoryName, session_key AS sessionKey,
                stage_id AS stageId, thread_id AS threadId
         FROM heddle_session_runtime
         WHERE session_key = ?`,
      )
      .get(record.sessionKey) as
      | (Omit<
          SessionRuntimeRecord,
          "binding" | "projectId" | "repositoryName"
        > & {
          bindingJson: string | null;
          projectId: string | null;
          repositoryName: string | null;
        })
      | undefined;
    const prior =
      priorRow === undefined
        ? undefined
        : {
            ...priorRow,
            binding:
              priorRow.bindingJson === null
                ? undefined
                : parseResolvedSessionBinding(
                    priorRow.bindingJson,
                    priorRow.sessionKey,
                    priorRow.threadId,
                  ),
            ...(priorRow.projectId === null
              ? { projectId: undefined }
              : { projectId: priorRow.projectId }),
            ...(priorRow.repositoryName === null
              ? { repositoryName: undefined }
              : { repositoryName: priorRow.repositoryName }),
          };
    if (prior !== undefined) {
      const coreChanged =
        prior.activation !== record.activation ||
        prior.binding === undefined ||
        !sameResolvedSessionBinding(prior.binding, record.binding) ||
        prior.instanceId !== record.instanceId ||
        prior.sessionKey !== record.sessionKey ||
        prior.stageId !== record.stageId ||
        prior.threadId !== record.threadId;
      const routeChanged =
        (prior.projectId !== undefined &&
          record.projectId !== undefined &&
          prior.projectId !== record.projectId) ||
        (prior.repositoryName !== undefined &&
          record.repositoryName !== undefined &&
          prior.repositoryName !== record.repositoryName);
      if (coreChanged || routeChanged) {
        throw new Error(
          `Session '${record.sessionKey}' changed durable identity`,
        );
      }
      if (
        (prior.projectId === undefined && record.projectId !== undefined) ||
        (prior.repositoryName === undefined &&
          record.repositoryName !== undefined)
      ) {
        this.database
          .prepare(
            `UPDATE heddle_session_runtime
             SET project_id = COALESCE(project_id, ?),
                 repository_name = COALESCE(repository_name, ?)
             WHERE session_key = ?`,
          )
          .run(
            record.projectId ?? null,
            record.repositoryName ?? null,
            record.sessionKey,
          );
      }
      return;
    }
    this.database
      .prepare(
        `INSERT INTO heddle_session_runtime
           (session_key, activation, binding_json, instance_id, project_id, repository_name,
            stage_id, thread_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.sessionKey,
        record.activation,
        serialize(record.binding),
        record.instanceId,
        record.projectId ?? null,
        record.repositoryName ?? null,
        record.stageId,
        record.threadId,
      );
  }

  close(): void {
    if (this.closed) return;
    this.flowcraftHistoryAdapter.close();
    this.database.close();
    this.closed = true;
  }

  private assertInstanceId(instanceId: string): void {
    if (instanceId.trim() === "") {
      throw new TypeError("instanceId must not be empty");
    }
  }

  private assertDigest(name: string, value: string): void {
    if (!/^[a-f0-9]{64}$/.test(value)) {
      throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
    }
  }

  private assertTaskId(name: string, value: number): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }

  private assertStableId(name: string, value: string): void {
    if (value.trim() === "") throw new TypeError(`${name} must not be empty`);
  }

  private assertExternalEventType(type: string): void {
    if (type.trim() === "") {
      throw new TypeError("Event type must not be empty");
    }
    if (stateEventTypes.has(type)) {
      throw new TypeError(`Event type is reserved: ${type}`);
    }
  }

  private getEvent(sequence: number): PersistedEvent {
    const row = this.database
      .prepare(
        `SELECT sequence, instance_id, type, payload_json, recorded_at
         FROM heddle_instance_events
         WHERE sequence = ?`,
      )
      .get(sequence) as EventRow | undefined;
    if (row === undefined) {
      throw new Error(`Event does not exist: ${sequence}`);
    }
    return parseEvent(row);
  }

  private getRequiredInstance(instanceId: string): InstanceRecord {
    const record = this.getInstance(instanceId);
    if (record === undefined) {
      throw new Error(`Instance does not exist: ${instanceId}`);
    }
    return record;
  }

  private insertEvent(
    instanceId: string,
    type: string,
    payloadJson: string,
  ): number {
    const result = this.database
      .prepare(
        `INSERT INTO heddle_instance_events
           (instance_id, type, payload_json, recorded_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(instanceId, type, payloadJson, new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  private insertDynamicTaskIntentEvent(
    operationDigest: string,
    type: DynamicTaskIntentEvent["type"],
    payloadJson: string,
    recordedAt: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO heddle_dynamic_task_intent_events
           (operation_digest, type, payload_json, recorded_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(operationDigest, type, payloadJson, recordedAt);
  }

  private getRequiredDynamicTaskIntent(
    operationDigest: string,
  ): DynamicTaskIntentRecord {
    const record = this.getDynamicTaskIntent(operationDigest);
    if (record === undefined) {
      throw new Error(
        `Dynamic task operation does not exist: ${operationDigest}`,
      );
    }
    return record;
  }

  private sameDynamicTaskIntent(
    input: DynamicTaskIntentInput,
    requestJson: string,
    record: DynamicTaskIntentRecord,
  ): boolean {
    return (
      record.operationDigest === input.operationDigest &&
      record.recordDigest === input.recordDigest &&
      record.sourceTaskId === input.sourceTaskId &&
      record.sourceInstanceId === input.sourceInstanceId &&
      record.sourceSessionKey === input.sourceSessionKey &&
      record.kind === input.kind &&
      record.parentEpicId === input.parentEpicId &&
      record.lifecycle === input.lifecycle &&
      serialize(record.request) === requestJson
    );
  }

  private toDynamicTaskIntent(
    row: DynamicTaskIntentRow,
  ): DynamicTaskIntentRecord {
    return {
      ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
      kind: row.kind,
      lifecycle: row.lifecycle,
      operationDigest: row.operation_digest,
      parentEpicId: row.parent_epic_id,
      recordDigest: row.record_digest,
      recordedAt: row.recorded_at,
      request: JSON.parse(row.request_json) as JsonValue,
      sourceInstanceId: row.source_instance_id,
      sourceSessionKey: row.source_session_key,
      sourceTaskId: row.source_task_id,
      state: row.state,
      ...(row.task_id === null ? {} : { taskId: row.task_id }),
    };
  }

  private latestSchedulerPassHistory(): SchedulerPassHistoryRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT sequence, episode, type, error_json AS errorJson,
                recorded_at AS recordedAt
         FROM heddle_scheduler_pass_history
         ORDER BY sequence DESC
         LIMIT 1`,
      )
      .get() as SchedulerPassHistoryRow | undefined;
    return row === undefined ? undefined : this.toSchedulerPassHistory(row);
  }

  private firstSchedulerPassFailure(episode: number): JsonValue {
    const row = this.database
      .prepare(
        `SELECT error_json AS errorJson
         FROM heddle_scheduler_pass_history
         WHERE episode = ? AND type = 'failure'
         ORDER BY sequence
         LIMIT 1`,
      )
      .get(episode) as { errorJson: string } | undefined;
    if (row === undefined) {
      throw new Error(`Scheduler pass episode ${episode} has no failure`);
    }
    return JSON.parse(row.errorJson) as JsonValue;
  }

  private insertSchedulerPassHistory(
    episode: number,
    type: SchedulerPassHistoryRecord["type"],
    errorJson: string | null,
  ): SchedulerPassHistoryRecord {
    const recordedAt = new Date().toISOString();
    const result = this.database
      .prepare(
        `INSERT INTO heddle_scheduler_pass_history
           (episode, type, error_json, recorded_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(episode, type, errorJson, recordedAt);
    return {
      episode,
      error: errorJson === null ? null : (JSON.parse(errorJson) as JsonValue),
      recordedAt,
      sequence: Number(result.lastInsertRowid),
      type,
    };
  }

  private toSchedulerPassHistory(
    row: SchedulerPassHistoryRow,
  ): SchedulerPassHistoryRecord {
    return {
      episode: row.episode,
      error:
        row.errorJson === null
          ? null
          : (JSON.parse(row.errorJson) as JsonValue),
      recordedAt: row.recordedAt,
      sequence: row.sequence,
      type: row.type,
    };
  }

  private instanceExists(instanceId: string): boolean {
    return (
      this.database
        .prepare("SELECT 1 FROM heddle_instances WHERE instance_id = ?")
        .get(instanceId) !== undefined
    );
  }

  private toInstanceRecord(row: InstanceRow): InstanceRecord {
    return {
      instanceId: row.instance_id,
      state: parseState(row.state_json),
      version: row.version,
    };
  }
}
