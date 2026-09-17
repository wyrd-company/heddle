// ---
// relationships:
//   implements: engine-and-run-model
// ---
import type { DatabaseSync } from "node:sqlite";
import { acquireWriter } from "./writer.js";
import { dueAt, duration as checkedDuration } from "./timing.js";
import type {
  Awaiting,
  Checkpoint,
  Data,
  Run,
  RunEvent,
  RunStatus,
} from "./types.js";

export class RunStore {
  readonly db: DatabaseSync;
  readonly active: Map<string, Promise<Run>>;
  private readonly release: () => void;
  constructor(path: string) {
    const owner = acquireWriter(path);
    this.db = owner.db;
    this.active = owner.active;
    this.release = owner.release;
  }
  close(): void {
    this.release();
  }
  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  create(run: Run): boolean {
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO runs
      (id,root_id,parent_id,parent_node_id,blueprint_id,blueprint_commit,blueprint,status,paused,initial_context,context,checkpoint)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          run.id,
          run.rootId,
          run.parentId,
          run.parentNodeId,
          run.blueprintId,
          run.commit,
          JSON.stringify(run.blueprint),
          run.status,
          Number(run.paused),
          JSON.stringify(run.initialContext),
          JSON.stringify(run.context),
          JSON.stringify(run.checkpoint),
        ).changes === 1
    );
  }
  get(id: string): Run {
    const row = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id);
    if (!row) throw new Error(`Unknown run: ${id}`);
    return {
      id: String(row["id"]),
      rootId: String(row["root_id"]),
      parentId: row["parent_id"] === null ? null : String(row["parent_id"]),
      parentNodeId:
        row["parent_node_id"] === null ? null : String(row["parent_node_id"]),
      blueprintId: String(row["blueprint_id"]),
      commit: String(row["blueprint_commit"]),
      blueprint: JSON.parse(String(row["blueprint"])) as Run["blueprint"],
      status: row["status"] as RunStatus,
      paused: row["paused"] === 1,
      initialContext: JSON.parse(String(row["initial_context"])) as Data,
      context: JSON.parse(String(row["context"])) as Data,
      checkpoint: JSON.parse(String(row["checkpoint"])) as Checkpoint,
    };
  }
  list(): Run[] {
    return this.db
      .prepare("SELECT id FROM runs ORDER BY rowid")
      .all()
      .map((row) => this.get(String(row["id"])));
  }
  event(runId: string, type: string, payload: unknown): void {
    this.db
      .prepare(
        `INSERT INTO events SELECT ?,COALESCE(MAX(sequence),0)+1,?,?
      FROM events WHERE run_id=?`,
      )
      .run(runId, type, JSON.stringify(payload ?? null), runId);
  }
  events(runId: string): RunEvent[] {
    return this.db
      .prepare("SELECT * FROM events WHERE run_id=? ORDER BY sequence")
      .all(runId)
      .map((row) => ({
        sequence: Number(row["sequence"]),
        type: String(row["type"]),
        payload: JSON.parse(String(row["payload"])) as unknown,
      }));
  }
  save(
    runId: string,
    context: Data,
    checkpoint: Checkpoint,
    status?: RunStatus,
  ): void {
    this.db
      .prepare(
        "UPDATE runs SET context=?,checkpoint=?,status=COALESCE(?,status) WHERE id=?",
      )
      .run(
        JSON.stringify(context),
        JSON.stringify(checkpoint),
        status ?? null,
        runId,
      );
  }
  status(runId: string, status: RunStatus): void {
    this.db.prepare("UPDATE runs SET status=? WHERE id=?").run(status, runId);
  }
  beginVisit(runId: string, nodeId: string): number {
    const row = this.db
      .prepare(
        `INSERT INTO visits VALUES (?,?,1,1)
      ON CONFLICT(run_id,node_id) DO UPDATE SET count=count+CASE WHEN active=0 THEN 1 ELSE 0 END,active=1
      RETURNING count`,
      )
      .get(runId, nodeId);
    return Number(row?.["count"]);
  }
  finishVisit(runId: string, nodeId: string): void {
    this.db
      .prepare("UPDATE visits SET active=0 WHERE run_id=? AND node_id=?")
      .run(runId, nodeId);
  }
  awaiting(runId?: string): Awaiting[] {
    const rows =
      runId === undefined
        ? this.db.prepare("SELECT * FROM awaiting").all()
        : this.db.prepare("SELECT * FROM awaiting WHERE run_id=?").all(runId);
    return rows.map((row) => ({
      runId: String(row["run_id"]),
      nodeId: String(row["node_id"]),
      visit: Number(row["visit"]),
      details: JSON.parse(String(row["details"])) as Awaiting["details"],
    }));
  }
  findAwaiting(
    field: "threadId" | "childRunId" | "issueId",
    value: string,
  ): Awaiting[] {
    const column = {
      threadId: "thread_id",
      childRunId: "child_run_id",
      issueId: "issue_id",
    }[field];
    const rows = this.db
      .prepare(`SELECT run_id,node_id FROM awaiting WHERE ${column}=?`)
      .all(value);
    return rows.flatMap((row) =>
      this.awaiting(String(row["run_id"])).filter(
        (item) => item.nodeId === row["node_id"],
      ),
    );
  }
  recordAwaiting(item: Awaiting, now: number): void {
    const { details, runId, nodeId, visit } = item;
    if (details.inactivity !== undefined) details.lastActivity ??= now;
    this.db
      .prepare("INSERT OR REPLACE INTO awaiting VALUES (?,?,?,?,?,?,?,?)")
      .run(
        runId,
        nodeId,
        visit,
        details.kind,
        details.threadId ?? null,
        details.childRunId ?? null,
        details.issueId ?? null,
        JSON.stringify(details),
      );
    for (const [result, duration] of [
      ["timeout", details.deadline],
      ["idle", details.inactivity],
    ] as const) {
      if (duration === undefined) continue;
      checkedDuration(duration);
      const due = dueAt(
        result === "idle" ? (details.lastActivity ?? now) : now,
        duration,
      );
      this.db
        .prepare(
          "INSERT OR IGNORE INTO wakeups(run_id,node_id,visit,result,due) VALUES (?,?,?,?,?)",
        )
        .run(
          runId,
          nodeId,
          visit,
          details.kind === "sleep" ? "completed" : result,
          due,
        );
    }
  }
}
