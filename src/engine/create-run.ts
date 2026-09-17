// ---
// relationships:
//   implements: engine-and-run-model
// ---
import { resultContractFindings } from "../blueprints/result-contracts.js";
import { isDeepStrictEqual } from "node:util";
import type { WorkflowBlueprint } from "flowcraft";
import type { RunStore } from "./store.js";
import type { Data, EngineOptions, LifecycleOrigin, Run } from "./types.js";

export interface RelatedRun {
  id: string;
  parentId: string;
  parentNodeId: string;
  blueprintId: string;
  context: Data;
}
export interface NewRun {
  id: string;
  blueprintId: string;
  commit: string;
  context?: Data;
  rootId: string;
  parentId: string | null;
  parentNodeId: string | null;
  lifecycleOrigin?: LifecycleOrigin;
}
export function createRelatedRun(
  store: RunStore,
  resolve: EngineOptions["resolveBlueprint"],
  input: RelatedRun,
): Promise<Run> {
  const parent = store.get(input.parentId);
  return createRun(store, resolve, {
    ...input,
    commit: parent.commit,
    rootId: parent.rootId,
  });
}
function sameRun(store: RunStore, existing: Run, input: NewRun): Run {
  const origin = store.lifecycleOrigin(existing.id);
  if (
    !isDeepStrictEqual(origin, input.lifecycleOrigin) ||
    existing.blueprintId !== input.blueprintId ||
    existing.commit !== input.commit ||
    existing.rootId !== input.rootId ||
    existing.parentId !== input.parentId ||
    existing.parentNodeId !== input.parentNodeId ||
    !isDeepStrictEqual(existing.initialContext, input.context ?? {})
  )
    throw new Error("Run identity already belongs to a different invocation");
  return existing;
}
export async function createRun(
  store: RunStore,
  resolve: EngineOptions["resolveBlueprint"],
  input: NewRun,
): Promise<Run> {
  if (store.db.prepare("SELECT 1 FROM runs WHERE id=?").get(input.id))
    return sameRun(store, store.get(input.id), input);
  const blueprint = structuredClone(
    await resolve(input.commit, input.blueprintId),
  );
  checkBlueprint(blueprint);
  if (blueprint.id !== input.blueprintId)
    throw new Error("Blueprint resolver returned a different identity");
  if (
    input.lifecycleOrigin &&
    (blueprint as WorkflowBlueprint & { kind?: string }).kind !== "process"
  )
    throw new Error("lifecycle-start requires a process blueprint");
  const context = structuredClone(input.context ?? {});
  const run: Run = {
    ...input,
    blueprint,
    status: "running",
    paused: input.parentId ? store.get(input.parentId).paused : false,
    initialContext: context,
    context,
    checkpoint: { context },
  };
  store.transaction(() => {
    if (store.create(run)) {
      store.event(run.id, "start", {
        blueprintId: run.blueprintId,
        commit: run.commit,
      });
      if (input.lifecycleOrigin) {
        const origin = input.lifecycleOrigin;
        store.db
          .prepare("INSERT INTO lifecycle_starts VALUES (?,?,?,?)")
          .run(origin.runId, origin.nodeId, origin.visit, run.id);
        store.event(origin.runId, "lifecycle-started", {
          ...origin,
          lifecycleRunId: run.id,
        });
      }
    }
  });
  return sameRun(store, store.get(run.id), input);
}
function checkBlueprint(blueprint: WorkflowBlueprint): void {
  const findings = resultContractFindings(blueprint);
  if (findings.length)
    throw new Error(
      findings
        .map((finding) => `${finding.node}: ${finding.message}`)
        .join("; "),
    );
  if (
    blueprint.nodes.some(
      (node) => node.uses === "subflow" || node.uses === "SubflowNode",
    )
  )
    throw new Error("subflow is excluded; use child-run");
  if (blueprint.edges.some((edge) => edge.action !== undefined))
    throw new Error("Action edges are excluded");
}
