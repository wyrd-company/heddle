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

    CREATE TABLE IF NOT EXISTS heddle_correlation_tokens (
      token TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      UNIQUE(instance_id, session_key)
    );

    CREATE INDEX IF NOT EXISTS heddle_instance_events_instance_sequence
      ON heddle_instance_events(instance_id, sequence);

    CREATE TABLE IF NOT EXISTS heddle_reconciler_runtime (
      instance_id TEXT PRIMARY KEY,
      task_id INTEGER NOT NULL UNIQUE,
      board_status TEXT NOT NULL,
      state TEXT NOT NULL,
      provider TEXT,
      deferral_json TEXT,
      stage_id TEXT,
      stage_entered_at INTEGER,
      session_key TEXT,
      thread_id TEXT
    );

    CREATE TABLE IF NOT EXISTS heddle_attention (
      attention_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS heddle_session_runtime (
      session_key TEXT PRIMARY KEY,
      activation INTEGER NOT NULL CHECK (activation > 0),
      instance_id TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      UNIQUE(instance_id, stage_id, activation)
    );

    CREATE TABLE IF NOT EXISTS heddle_completed_effects (
      effect_kind TEXT NOT NULL,
      stable_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
      payload_json TEXT NOT NULL DEFAULT 'null',
      recorded_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY (effect_kind, stable_id)
    );

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

  const attentionColumns = database
    .prepare("PRAGMA table_info(heddle_attention)")
    .all() as Array<{ name: string }>;
  if (!attentionColumns.some(({ name }) => name === "resolved_at")) {
    database.exec("ALTER TABLE heddle_attention ADD COLUMN resolved_at TEXT");
  }
  const effectColumns = database
    .prepare("PRAGMA table_info(heddle_completed_effects)")
    .all() as Array<{ name: string }>;
  if (!effectColumns.some(({ name }) => name === "payload_json")) {
    database.exec(
      "ALTER TABLE heddle_completed_effects ADD COLUMN payload_json TEXT NOT NULL DEFAULT 'null'",
    );
  }
};

export const protectFlowcraftHistory = (database: Database.Database): void => {
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS heddle_flowcraft_events_no_update
    BEFORE UPDATE ON events
    BEGIN
      SELECT RAISE(ABORT, 'flowcraft history is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS heddle_flowcraft_events_no_delete
    BEFORE DELETE ON events
    BEGIN
      SELECT RAISE(ABORT, 'flowcraft history is append-only');
    END;
  `);
};
