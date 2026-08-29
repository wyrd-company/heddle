// ---
// relationships:
//   implements: heddle
// ---

import type Database from "better-sqlite3";

import type { EventRow, InstanceRecord, InstanceState } from "./types.js";

export const instanceCreatedEvent = "instance:created";
export const instanceDeletedEvent = "instance:deleted";
export const instanceUpdatedEvent = "instance:updated";

export const stateEventTypes = new Set([
  instanceCreatedEvent,
  instanceUpdatedEvent,
  instanceDeletedEvent,
]);

export const recoverInstances = (
  database: Database.Database,
): InstanceRecord[] =>
  database.transaction(() => {
    const rows = database
      .prepare(
        `SELECT sequence, instance_id, type, payload_json, recorded_at
         FROM heddle_instance_events
         ORDER BY sequence`,
      )
      .all() as EventRow[];
    const recovered = new Map<string, InstanceRecord>();

    for (const row of rows) {
      if (row.type === instanceCreatedEvent) {
        recovered.set(row.instance_id, {
          instanceId: row.instance_id,
          state: JSON.parse(row.payload_json) as InstanceState,
          version: 1,
        });
      } else if (row.type === instanceUpdatedEvent) {
        const current = recovered.get(row.instance_id);
        if (current === undefined) {
          throw new Error(
            `Cannot replay update for missing instance: ${row.instance_id}`,
          );
        }
        recovered.set(row.instance_id, {
          instanceId: row.instance_id,
          state: JSON.parse(row.payload_json) as InstanceState,
          version: current.version + 1,
        });
      } else if (row.type === instanceDeletedEvent) {
        recovered.delete(row.instance_id);
      }
    }

    database.prepare("DELETE FROM heddle_instances").run();
    const insert = database.prepare(
      `INSERT INTO heddle_instances (instance_id, state_json, version)
       VALUES (?, ?, ?)`,
    );
    for (const record of recovered.values()) {
      insert.run(
        record.instanceId,
        JSON.stringify(record.state),
        record.version,
      );
    }
    return [...recovered.values()].sort((left, right) =>
      left.instanceId < right.instanceId
        ? -1
        : left.instanceId > right.instanceId
          ? 1
          : 0,
    );
  })();
