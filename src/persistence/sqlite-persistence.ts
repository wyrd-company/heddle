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
  initializePersistenceSchema,
  protectFlowcraftHistory,
} from "./sqlite-schema.js";
import type {
  DurableAttentionRecord,
  EpicProjectRecord,
  EventRow,
  InstanceEventClaim,
  InstanceRecord,
  InstanceRow,
  InstanceState,
  JsonValue,
  PersistedEvent,
  PersistenceConfiguration,
  ReconcilerRuntimeRecord,
  SessionRuntimeRecord,
} from "./types.js";

const databaseFilename = "heddle-state.sqlite";
const serialize = (value: JsonValue | InstanceState): string => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Persistence values must be JSON serializable");
  }
  return serialized;
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

  resolveAttention(attentionId: string): boolean {
    this.assertStableId("attentionId", attentionId);
    const resolved =
      this.database
        .prepare(
          `UPDATE heddle_attention
           SET resolved_at = ?
           WHERE attention_id = ? AND resolved_at IS NULL`,
        )
        .run(new Date().toISOString(), attentionId).changes > 0;
    if (resolved) return true;
    if (this.hasAttention(attentionId)) return false;
    throw new Error(`Attention ${JSON.stringify(attentionId)} does not exist`);
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

  listSessionRuntime(): SessionRuntimeRecord[] {
    const rows = this.database
      .prepare(
        `SELECT activation, instance_id AS instanceId, project_id AS projectId,
                repository_name AS repositoryName, session_key AS sessionKey,
                stage_id AS stageId, thread_id AS threadId
         FROM heddle_session_runtime
         ORDER BY instance_id, stage_id, activation`,
      )
      .all() as Array<
      Omit<SessionRuntimeRecord, "projectId" | "repositoryName"> & {
        projectId: string | null;
        repositoryName: string | null;
      }
    >;
    return rows.map(({ projectId, repositoryName, ...row }) => ({
      ...row,
      ...(projectId === null ? {} : { projectId }),
      ...(repositoryName === null ? {} : { repositoryName }),
    }));
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
    const priorRow = this.database
      .prepare(
        `SELECT activation, instance_id AS instanceId, project_id AS projectId,
                repository_name AS repositoryName, session_key AS sessionKey,
                stage_id AS stageId, thread_id AS threadId
         FROM heddle_session_runtime
         WHERE session_key = ?`,
      )
      .get(record.sessionKey) as
      | (Omit<SessionRuntimeRecord, "projectId" | "repositoryName"> & {
          projectId: string | null;
          repositoryName: string | null;
        })
      | undefined;
    const prior =
      priorRow === undefined
        ? undefined
        : {
            ...priorRow,
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
           (session_key, activation, instance_id, project_id, repository_name,
            stage_id, thread_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.sessionKey,
        record.activation,
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
