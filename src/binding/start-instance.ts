// ---
// relationships:
//   implements: github-binding-and-intake
// ---
import type { WorkflowEngine } from "../engine/engine.js";
import type { RunStore } from "../engine/store.js";
import type { InstanceStore } from "./store.js";

export async function startBoundInstance(
  store: RunStore,
  instances: InstanceStore,
  engine: WorkflowEngine,
  hasProject: (id: string) => boolean,
  id: string,
  blueprintId: string,
  commit: string,
) {
  const instance = instances.get(id);
  if (instances.ambiguous(id))
    throw new Error(
      "Issue belongs to multiple bound projects; select its project before starting",
    );
  if (
    instance.runId &&
    store.db.prepare("SELECT 1 FROM runs WHERE id=?").get(instance.runId)
  ) {
    const run = store.get(instance.runId);
    if (run.blueprintId !== blueprintId || run.commit !== commit)
      throw new Error("Instance already has a different lifecycle invocation");
    await engine.recover(run.rootId);
    return store.get(run.id);
  }
  if (!hasProject(instance.issue.project.id))
    throw new Error(
      "Project reconciliation requires attention before starting an instance",
    );
  const runId = instance.runId ?? `issue:${id}`;
  instances.attach(id, runId);
  return engine.start({
    id: runId,
    blueprintId,
    commit,
    context: { issue: structuredClone(instance.issue) },
  });
}
