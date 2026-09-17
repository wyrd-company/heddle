// ---
// relationships:
//   implements: engine-and-run-model
// ---
import { isDeepStrictEqual } from "node:util";
import type { WorkflowBlueprint } from "flowcraft";
import type { RunStore } from "./store.js";
import type { Data, EngineOptions, Run } from "./types.js";

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
}
function sameRun(existing: Run, input: NewRun): Run {
  if (
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
    return sameRun(store.get(input.id), input);
  const blueprint = structuredClone(
    await resolve(input.commit, input.blueprintId),
  );
  checkBlueprint(blueprint);
  if (blueprint.id !== input.blueprintId)
    throw new Error("Blueprint resolver returned a different identity");
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
    if (store.create(run))
      store.event(run.id, "start", {
        blueprintId: run.blueprintId,
        commit: run.commit,
      });
  });
  return sameRun(store.get(run.id), input);
}
function checkBlueprint(blueprint: WorkflowBlueprint): void {
  if (
    blueprint.nodes.some(
      (node) => node.uses === "subflow" || node.uses === "SubflowNode",
    )
  )
    throw new Error("subflow is excluded; use child-run");
  if (blueprint.edges.some((edge) => edge.action !== undefined))
    throw new Error("Action edges are excluded");
}
