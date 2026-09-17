// ---
// relationships:
//   implements: engine-and-run-model
// ---
import type { RunStore } from "./store.js";
import type { ResumeInput } from "./types.js";

export function claimResume(
  store: RunStore,
  request: ResumeInput,
): "applied" | "late-wakeup" | "held" {
  return store.transaction(() => {
    const run = store.get(request.runId);
    if (run.paused) {
      store.db
        .prepare("INSERT INTO held_resumes(run_id,request) VALUES (?,?)")
        .run(run.id, JSON.stringify(request));
      store.event(run.id, "held-wakeup", request);
      return "held";
    }
    const changes = store.db
      .prepare(
        `UPDATE runs SET status='resuming' WHERE id=? AND status='awaiting'
      AND EXISTS (SELECT 1 FROM awaiting WHERE run_id=? AND node_id=? AND (? IS NULL OR visit=?))`,
      )
      .run(
        run.id,
        run.id,
        request.nodeId,
        request.visit ?? null,
        request.visit ?? null,
      ).changes;
    if (changes !== 1) {
      store.event(run.id, "late-wakeup", request);
      return "late-wakeup";
    }
    const awaiting = store
      .awaiting(run.id)
      .find((item) => item.nodeId === request.nodeId);
    const mapped =
      awaiting?.details.kind === "child-run" &&
      request.result === "completed" &&
      request.payload !== null &&
      typeof request.payload === "object"
        ? request.payload
        : {};
    const output = {
      ...mapped,
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
  });
}
