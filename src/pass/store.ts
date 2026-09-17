// ---
// relationships:
//   implements: node-types
// ---
import type { RunStore, Awaiting } from "../engine/index.js";
import type { PassInvocation } from "./types.js";

export class PassStore {
  constructor(readonly runs: RunStore) {
    runs.db.exec(`CREATE TABLE IF NOT EXISTS pass_invocations (
      effect_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, thread_id TEXT NOT NULL, data TEXT NOT NULL
    )`);
  }
  get(key: string): PassInvocation | undefined {
    const row = this.runs.db
      .prepare("SELECT data FROM pass_invocations WHERE effect_key=?")
      .get(key);
    return row
      ? (JSON.parse(String(row["data"])) as PassInvocation)
      : undefined;
  }
  all(runId?: string): PassInvocation[] {
    const rows =
      runId === undefined
        ? this.runs.db.prepare("SELECT data FROM pass_invocations").all()
        : this.runs.db
            .prepare("SELECT data FROM pass_invocations WHERE run_id=?")
            .all(runId);
    return rows.map((row) => JSON.parse(String(row["data"])) as PassInvocation);
  }
  awaiting(item: PassInvocation): Awaiting | undefined {
    const run = this.runs.get(item.runId);
    if (run.status === "failed" || run.status === "completed") return undefined;
    return this.runs
      .awaiting(item.runId)
      .find(
        (row) =>
          row.nodeId === item.nodeId &&
          row.visit === item.visit &&
          row.details.threadId === item.threadId,
      );
  }
  save(item: PassInvocation): void {
    if (item.phase !== "retired" && this.get(item.key)?.phase === "retired")
      return;
    this.runs.db
      .prepare(
        `INSERT INTO pass_invocations(effect_key,run_id,thread_id,data) VALUES (?,?,?,?)
      ON CONFLICT(effect_key) DO UPDATE SET data=excluded.data`,
      )
      .run(item.key, item.runId, item.threadId, JSON.stringify(item));
  }
}
