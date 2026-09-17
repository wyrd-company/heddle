// ---
// relationships:
//   implements: engine-and-run-model
// ---
export const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, root_id TEXT NOT NULL, parent_id TEXT, parent_node_id TEXT,
  blueprint_id TEXT NOT NULL, blueprint_commit TEXT NOT NULL, blueprint TEXT NOT NULL,
  status TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
  initial_context TEXT NOT NULL, context TEXT NOT NULL, checkpoint TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_root ON runs(root_id);
CREATE TABLE IF NOT EXISTS awaiting (
  run_id TEXT NOT NULL REFERENCES runs(id), node_id TEXT NOT NULL, visit INTEGER NOT NULL,
  kind TEXT NOT NULL, thread_id TEXT, child_run_id TEXT, issue_id TEXT, details TEXT NOT NULL,
  PRIMARY KEY(run_id, node_id)
);
CREATE INDEX IF NOT EXISTS awaiting_thread ON awaiting(thread_id);
CREATE INDEX IF NOT EXISTS awaiting_child ON awaiting(child_run_id);
CREATE INDEX IF NOT EXISTS awaiting_issue ON awaiting(issue_id);
CREATE TABLE IF NOT EXISTS visits (
  run_id TEXT NOT NULL REFERENCES runs(id), node_id TEXT NOT NULL,
  count INTEGER NOT NULL, active INTEGER NOT NULL,
  PRIMARY KEY(run_id, node_id)
);
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL REFERENCES runs(id), sequence INTEGER NOT NULL,
  type TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(run_id, sequence)
);
CREATE TABLE IF NOT EXISTS wakeups (
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
  node_id TEXT NOT NULL, visit INTEGER NOT NULL, result TEXT NOT NULL, due REAL NOT NULL,
  UNIQUE(run_id, node_id, visit, result)
);
CREATE INDEX IF NOT EXISTS wakeups_due ON wakeups(due);
CREATE TABLE IF NOT EXISTS held_resumes (
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), request TEXT NOT NULL
);
`;
