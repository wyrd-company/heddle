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
  EventRow,
  InstanceEventClaim,
  InstanceRecord,
  InstanceRow,
  InstanceState,
  JsonValue,
  PersistedEvent,
  PersistenceConfiguration,
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
