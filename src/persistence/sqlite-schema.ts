// ---
// relationships:
//   implements: heddle
// ---

import type Database from "better-sqlite3";

export const initializePersistenceSchema = (
  database: Database.Database,
): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS heddle_instances (
      instance_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0)
    );

    CREATE TABLE IF NOT EXISTS heddle_instance_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS heddle_instance_events_instance_sequence
      ON heddle_instance_events(instance_id, sequence);

    CREATE TRIGGER IF NOT EXISTS heddle_instance_events_no_update
    BEFORE UPDATE ON heddle_instance_events
    BEGIN
      SELECT RAISE(ABORT, 'heddle instance history is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS heddle_instance_events_no_delete
    BEFORE DELETE ON heddle_instance_events
    BEGIN
      SELECT RAISE(ABORT, 'heddle instance history is append-only');
    END;
  `);
};
