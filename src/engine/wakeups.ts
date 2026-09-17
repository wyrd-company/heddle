// ---
// relationships:
//   implements: engine-and-run-model
// ---
import type { RunStore } from "./store.js";
import type { ResumeInput, Wakeup } from "./types.js";
import { dueAt } from "./timing.js";

export class Wakeups {
  constructor(private readonly store: RunStore) {}
  due(now: number): Wakeup[] {
    return this.store.db
      .prepare(
        `SELECT w.* FROM wakeups w JOIN runs r ON r.id=w.run_id
      WHERE w.due<=? AND r.paused=0 ORDER BY w.due,w.id`,
      )
      .all(now)
      .map((row) => ({
        id: Number(row["id"]),
        runId: String(row["run_id"]),
        nodeId: String(row["node_id"]),
        visit: Number(row["visit"]),
        result: String(row["result"]),
        due: Number(row["due"]),
      }));
  }
  activity(runId: string, nodeId: string, observedAt: number): void {
    if (!Number.isFinite(observedAt))
      throw new Error("Activity requires a finite observed time");
    this.store.transaction(() => {
      const item = this.store
        .awaiting(runId)
        .find((item) => item.nodeId === nodeId);
      if (item?.details.inactivity === undefined) return;
      const latest = Math.max(
        item.details.lastActivity ?? -Infinity,
        observedAt,
      );
      item.details.lastActivity = latest;
      this.store.db
        .prepare("UPDATE awaiting SET details=? WHERE run_id=? AND node_id=?")
        .run(JSON.stringify(item.details), runId, nodeId);
      this.store.db
        .prepare(
          "UPDATE wakeups SET due=? WHERE run_id=? AND node_id=? AND visit=? AND result='idle'",
        )
        .run(dueAt(latest, item.details.inactivity), runId, nodeId, item.visit);
      this.store.event(runId, "activity", { nodeId, observedAt });
    });
  }
  async tick(
    now: number,
    resume: (input: ResumeInput) => Promise<string>,
  ): Promise<void> {
    for (const wakeup of this.due(now)) {
      const current = this.store.db
        .prepare(
          `SELECT w.id FROM wakeups w JOIN runs r ON r.id=w.run_id
         WHERE w.id=? AND w.due<=? AND r.paused=0`,
        )
        .get(wakeup.id, now);
      if (!current) continue;
      const outcome = await resume({ ...wakeup, payload: { due: wakeup.due } });
      if (outcome !== "held")
        this.store.db.prepare("DELETE FROM wakeups WHERE id=?").run(wakeup.id);
    }
  }
}
