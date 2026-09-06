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
      lifecycle_repository_name TEXT,
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
      project_id TEXT,
      repository_name TEXT,
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

    CREATE TABLE IF NOT EXISTS heddle_notification_failures (
      stable_id TEXT PRIMARY KEY,
      occurrence INTEGER NOT NULL CHECK (occurrence > 0),
      category TEXT NOT NULL CHECK (category IN (
        'application-credential-rejected',
        'legacy-intent-unverifiable',
        'provider-quota-exceeded',
        'recipient-rejected',
        'request-rejected'
      )),
      recipient_label TEXT,
      message TEXT,
      state TEXT NOT NULL CHECK (state IN ('rejected', 'retry-authorized')),
      recorded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS heddle_notification_retries (
      stable_id TEXT PRIMARY KEY,
      category TEXT NOT NULL CHECK (category IN (
        'invalid-response',
        'network-failure',
        'provider-unavailable',
        'transport-failure'
      )),
      retry_not_before INTEGER NOT NULL CHECK (retry_not_before >= 0)
    );

    CREATE TABLE IF NOT EXISTS heddle_production_error_page_attempts (
      code TEXT NOT NULL,
      attention_id TEXT NOT NULL,
      attempted_at INTEGER NOT NULL CHECK (attempted_at >= 0),
      delivery_attempted INTEGER NOT NULL DEFAULT 1 CHECK (delivery_attempted IN (0, 1)),
      PRIMARY KEY (code, attention_id)
    );

    CREATE INDEX IF NOT EXISTS heddle_production_error_page_attempts_code_time
      ON heddle_production_error_page_attempts(code, attempted_at);

    CREATE TABLE IF NOT EXISTS heddle_epic_projects (
      epic_id INTEGER PRIMARY KEY,
      product_name TEXT NOT NULL,
      project_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('creating', 'active', 'deleting')),
      deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
      create_command_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      delete_command_id TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS heddle_dynamic_task_intents (
      operation_digest TEXT PRIMARY KEY CHECK (length(operation_digest) = 64),
      record_digest TEXT NOT NULL CHECK (length(record_digest) = 64),
      source_task_id INTEGER NOT NULL CHECK (source_task_id > 0),
      source_instance_id TEXT NOT NULL,
      source_session_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('finding', 'follow-up')),
      parent_epic_id INTEGER NOT NULL CHECK (parent_epic_id > 0),
      lifecycle TEXT NOT NULL,
      request_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
      task_id INTEGER UNIQUE CHECK (task_id > 0),
      recorded_at TEXT NOT NULL,
      completed_at TEXT,
      CHECK (
        (state = 'pending' AND task_id IS NULL AND completed_at IS NULL) OR
        (state = 'completed' AND task_id IS NOT NULL AND completed_at IS NOT NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS heddle_dynamic_task_intent_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_digest TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('pending', 'completed')),
      payload_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS heddle_dynamic_task_intent_events_operation_sequence
      ON heddle_dynamic_task_intent_events(operation_digest, sequence);

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

    CREATE TRIGGER IF NOT EXISTS heddle_dynamic_task_intent_events_no_update
    BEFORE UPDATE ON heddle_dynamic_task_intent_events
    BEGIN
      SELECT RAISE(ABORT, 'dynamic task intent history is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS heddle_dynamic_task_intent_events_no_delete
    BEFORE DELETE ON heddle_dynamic_task_intent_events
    BEGIN
      SELECT RAISE(ABORT, 'dynamic task intent history is append-only');
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
  const productionErrorPageAttemptColumns = database
    .prepare("PRAGMA table_info(heddle_production_error_page_attempts)")
    .all() as Array<{ name: string }>;
  if (
    !productionErrorPageAttemptColumns.some(
      ({ name }) => name === "delivery_attempted",
    )
  ) {
    database.exec(
      "ALTER TABLE heddle_production_error_page_attempts ADD COLUMN delivery_attempted INTEGER NOT NULL DEFAULT 1 CHECK (delivery_attempted IN (0, 1))",
    );
  }
  const notificationFailureColumns = database
    .prepare("PRAGMA table_info(heddle_notification_failures)")
    .all() as Array<{ name: string }>;
  if (
    !notificationFailureColumns.some(({ name }) => name === "recipient_label")
  ) {
    database.exec(
      "ALTER TABLE heddle_notification_failures ADD COLUMN recipient_label TEXT",
    );
  }
  if (!notificationFailureColumns.some(({ name }) => name === "message")) {
    database.exec(
      "ALTER TABLE heddle_notification_failures ADD COLUMN message TEXT",
    );
  }
  const reconcilerColumns = database
    .prepare("PRAGMA table_info(heddle_reconciler_runtime)")
    .all() as Array<{ name: string }>;
  if (
    !reconcilerColumns.some(({ name }) => name === "lifecycle_repository_name")
  ) {
    database.exec(
      "ALTER TABLE heddle_reconciler_runtime ADD COLUMN lifecycle_repository_name TEXT",
    );
  }
  const sessionColumns = database
    .prepare("PRAGMA table_info(heddle_session_runtime)")
    .all() as Array<{ name: string }>;
  if (!sessionColumns.some(({ name }) => name === "project_id")) {
    database.exec(
      "ALTER TABLE heddle_session_runtime ADD COLUMN project_id TEXT",
    );
  }
  if (!sessionColumns.some(({ name }) => name === "repository_name")) {
    database.exec(
      "ALTER TABLE heddle_session_runtime ADD COLUMN repository_name TEXT",
    );
  }
  const epicProjectColumns = database
    .prepare("PRAGMA table_info(heddle_epic_projects)")
    .all() as Array<{ name: string }>;
  if (!epicProjectColumns.some(({ name }) => name === "deleted")) {
    database.exec(
      "ALTER TABLE heddle_epic_projects ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))",
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
