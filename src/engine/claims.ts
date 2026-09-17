// ---
// relationships:
//   implements: engine-and-run-model
// ---
import type { RunStore } from "./store.js";
import type { ResumeInput } from "./types.js";

export function claimResume(
  store: RunStore,
  request: ResumeInput,
  transaction = true,
): "applied" | "late-wakeup" | "held" {
  const claim = (): "applied" | "late-wakeup" | "held" => {
    const run = store.get(request.runId);
    const awaiting = store
      .awaiting(run.id)
      .find(
        (item) =>
          item.nodeId === request.nodeId &&
          (request.visit === undefined || item.visit === request.visit),
      );
    if (!awaiting || run.status === "completed" || run.status === "failed") {
      store.event(run.id, "late-wakeup", request);
      return "late-wakeup";
    }
    if (run.paused || run.status !== "awaiting") {
      const bound = { ...request, visit: awaiting.visit };
      store.db
        .prepare("INSERT INTO held_resumes(run_id,request) VALUES (?,?)")
        .run(run.id, JSON.stringify(bound));
      store.event(run.id, "held-wakeup", bound);
      return "held";
    }
    store.db
      .prepare("UPDATE runs SET status='resuming' WHERE id=?")
      .run(run.id);
    const output = {
      [request.result]: true,
      payload: request.payload ?? null,
    };
    store.save(
      run.id,
      run.context,
      { context: run.context, nodeId: request.nodeId, output },
      "resuming",
    );
    store.db
      .prepare("DELETE FROM awaiting WHERE run_id=? AND node_id=?")
      .run(run.id, request.nodeId);
    store.event(run.id, "resume", request);
    return "applied";
  };
  return transaction ? store.transaction(claim) : claim();
}

export async function drainQueued(
  store: RunStore,
  runId: string,
  execute: (id: string) => Promise<unknown>,
): Promise<void> {
  let after = 0;
  for (;;) {
    const run = store.get(runId);
    if (run.paused || run.status === "running" || run.status === "resuming")
      return;
    const row = store.db
      .prepare(
        "SELECT * FROM held_resumes WHERE run_id=? AND id>? ORDER BY id LIMIT 1",
      )
      .get(runId, after);
    if (!row) return;
    after = Number(row["id"]);
    // Dequeue and claim are one commit: death cannot lose the queued request.
    const outcome = store.transaction(() => {
      const result = claimResume(
        store,
        JSON.parse(String(row["request"])) as ResumeInput,
        false,
      );
      store.db
        .prepare("DELETE FROM held_resumes WHERE id=?")
        .run(row["id"] ?? null);
      return result;
    });
    if (outcome === "applied") await execute(runId);
  }
}
