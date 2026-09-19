// ---
// relationships:
//   implements: agent-tools
// ---
import type { Awaiting, RunStore } from "../engine/index.js";
import { hashToken, toolState, type ToolBinding } from "./state.js";

export interface SessionBinding extends ToolBinding {
  runId: string;
  nodeId: string;
  visit: number;
  threadId: string;
}

/** Owned by the service's existing SQLite writer, never opened by a hook. */
export class HookSessions {
  constructor(private readonly store: RunStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS hook_sessions (
      run_id TEXT NOT NULL, node_id TEXT NOT NULL, visit INTEGER NOT NULL,
      thread_id TEXT NOT NULL, session_id TEXT, path TEXT NOT NULL, token TEXT NOT NULL,
      PRIMARY KEY(run_id,node_id,visit)
    ); CREATE INDEX IF NOT EXISTS hook_sessions_native ON hook_sessions(session_id);`);
  }

  register(item: Awaiting, binding: ToolBinding): void {
    if (
      !item.details.threadId ||
      !this.current({
        ...binding,
        runId: item.runId,
        nodeId: item.nodeId,
        visit: item.visit,
        threadId: item.details.threadId,
      })
    )
      throw new Error("Cannot register an inactive pass binding");
    const conflicting = this.store.db
      .prepare("SELECT * FROM hook_sessions WHERE thread_id=?")
      .all(item.details.threadId)
      .map(decode)
      .filter((row) => this.current(row));
    if (
      conflicting.some(
        (row) =>
          row.runId !== item.runId ||
          row.nodeId !== item.nodeId ||
          row.visit !== item.visit,
      )
    )
      throw new Error("T3 thread already belongs to an active pass");
    this.store.db
      .prepare(
        `INSERT INTO hook_sessions
      (run_id,node_id,visit,thread_id,path,token) VALUES (?,?,?,?,?,?)
      ON CONFLICT(run_id,node_id,visit) DO UPDATE SET
      thread_id=excluded.thread_id,path=excluded.path,token=excluded.token`,
      )
      .run(
        item.runId,
        item.nodeId,
        item.visit,
        item.details.threadId,
        binding.path,
        binding.token,
      );
  }

  /** Called only with the authoritative T3 session snapshot/event identity. */
  observe(binding: SessionBinding, sessionId: string | null): void {
    if (!this.current(binding)) return;
    if (sessionId !== null && sessionId.length === 0)
      throw new Error("Native session identity must not be empty");
    this.store.db
      .prepare(
        `UPDATE hook_sessions SET session_id=?
      WHERE run_id=? AND node_id=? AND visit=? AND thread_id=? AND path=?`,
      )
      .run(
        sessionId,
        binding.runId,
        binding.nodeId,
        binding.visit,
        binding.threadId,
        binding.path,
      );
  }

  /** Unknown sessions are a read-only miss, including unreconciled terminal rows. */
  resolve(sessionId: string): SessionBinding | undefined {
    const matches = this.store.db
      .prepare("SELECT * FROM hook_sessions WHERE session_id=?")
      .all(sessionId)
      .map(decode)
      .filter((row) => this.current(row));
    if (matches.length > 1)
      throw new Error("Ambiguous native session identity in Heddle state");
    return matches[0];
  }

  /** Run before accepting hook traffic after recovery and after terminal changes. */
  reconcile(): void {
    for (const row of this.store.db
      .prepare("SELECT * FROM hook_sessions")
      .all()) {
      const binding = decode(row);
      if (this.current(binding)) continue;
      this.store.db
        .prepare(
          "DELETE FROM hook_sessions WHERE run_id=? AND node_id=? AND visit=?",
        )
        .run(binding.runId, binding.nodeId, binding.visit);
    }
  }

  private current(binding: SessionBinding): boolean {
    const row = this.store.db
      .prepare(
        `SELECT a.details FROM awaiting a
      JOIN runs r ON r.id=a.run_id
      WHERE a.run_id=? AND a.node_id=? AND a.visit=? AND a.thread_id=?
      AND r.status NOT IN ('failed','completed')`,
      )
      .get(binding.runId, binding.nodeId, binding.visit, binding.threadId);
    if (!row) return false;
    const details = JSON.parse(String(row["details"])) as Awaiting["details"];
    const state = details["agentTools"] as ReturnType<typeof toolState>;
    return (
      details.kind === "pass" &&
      state?.path === binding.path &&
      !state.revoked &&
      state.tokenHash === hashToken(binding.token)
    );
  }
}

function decode(row: Record<string, unknown>): SessionBinding {
  return {
    runId: String(row["run_id"]),
    nodeId: String(row["node_id"]),
    visit: Number(row["visit"]),
    threadId: String(row["thread_id"]),
    path: String(row["path"]),
    token: String(row["token"]),
  };
}
