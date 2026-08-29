// ---
// relationships:
//   implements: heddle
// ---

import { SqliteHistoryAdapter } from "@flowcraft/sqlite-history";
import type Database from "better-sqlite3";

type FlowcraftEvent = Awaited<
  ReturnType<SqliteHistoryAdapter["retrieve"]>
>[number];

interface FlowcraftEventRow {
  event_payload: string;
  event_type: string;
}

interface MultipleFlowcraftEventRow extends FlowcraftEventRow {
  execution_id: string;
}

export interface SqliteFlowcraftHistory {
  append: SqliteHistoryAdapter["store"];
  replay: SqliteHistoryAdapter["retrieve"];
  replayMultiple: SqliteHistoryAdapter["retrieveMultiple"];
}

const parseFlowcraftEvent = (row: FlowcraftEventRow): FlowcraftEvent =>
  ({
    type: row.event_type,
    payload: JSON.parse(row.event_payload),
  }) as FlowcraftEvent;

export const createSqliteFlowcraftHistory = (
  database: Database.Database,
  adapter: SqliteHistoryAdapter,
): SqliteFlowcraftHistory => {
  const history: SqliteFlowcraftHistory = {
    append: (event, executionId) => adapter.store(event, executionId),
    replay: (executionId) => {
      const rows = database
        .prepare(
          `SELECT event_type, event_payload
           FROM events
           WHERE execution_id = ?
           ORDER BY timestamp ASC, id ASC`,
        )
        .all(executionId) as FlowcraftEventRow[];
      return Promise.resolve(rows.map(parseFlowcraftEvent));
    },
    replayMultiple: (executionIds) => {
      const placeholders = executionIds.map(() => "?").join(",");
      const rows = database
        .prepare(
          `SELECT execution_id, event_type, event_payload
           FROM events
           WHERE execution_id IN (${placeholders})
           ORDER BY execution_id ASC, timestamp ASC, id ASC`,
        )
        .all(...executionIds) as MultipleFlowcraftEventRow[];
      const result = new Map<string, FlowcraftEvent[]>();

      for (const row of rows) {
        const executionId = row.execution_id;
        const events = result.get(executionId) ?? [];
        events.push(parseFlowcraftEvent(row));
        result.set(executionId, events);
      }
      for (const executionId of executionIds) {
        if (!result.has(executionId)) result.set(executionId, []);
      }

      return Promise.resolve(result);
    },
  };
  return Object.freeze(history);
};
