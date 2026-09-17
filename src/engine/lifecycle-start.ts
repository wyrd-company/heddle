// ---
// relationships:
//   implements:
//     - node-types
//     - engine-and-run-model
// ---
import { isDeepStrictEqual } from "node:util";
import { createRun } from "./create-run.js";
import type { RunStore } from "./store.js";
import type { Data, EngineNodeContext, EngineOptions } from "./types.js";

function object(value: unknown): value is Data {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function lifecycleStart(
  store: RunStore,
  resolve: EngineOptions["resolveBlueprint"],
  context: EngineNodeContext,
): Promise<unknown> {
  const { run, nodeId, visit, effectKey, params } = context;
  const blueprint = params["blueprint"];
  if (
    typeof blueprint !== "string" ||
    !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u.test(blueprint)
  )
    throw new Error("lifecycle-start requires a blueprint id");
  const inputs = params["inputs"] === undefined ? {} : params["inputs"];
  if (!object(inputs) || Object.hasOwn(inputs, "issue"))
    throw new Error("lifecycle-start inputs must be an object without issue");
  const issue = context.context["issue"];
  const initialIssue = run.initialContext["issue"];
  if (
    !object(issue) ||
    typeof issue["id"] !== "string" ||
    issue["id"].length === 0 ||
    !object(initialIssue) ||
    issue["id"] !== initialIssue["id"]
  )
    throw new Error("lifecycle-start requires the intake issue identity");
  // Capture values before asynchronous target resolution. Neither later node writes
  // nor a moved blueprint repository can change the selected invocation.
  const initialContext = structuredClone({ ...inputs, issue });
  if (
    !isDeepStrictEqual(
      JSON.parse(JSON.stringify(initialContext)),
      initialContext,
    )
  )
    throw new Error("lifecycle-start requires JSON input values");
  const started = await createRun(store, resolve, {
    id: effectKey,
    rootId: effectKey,
    parentId: null,
    parentNodeId: null,
    blueprintId: blueprint,
    commit: run.commit,
    context: initialContext,
    lifecycleOrigin: { runId: run.id, nodeId, visit },
  });
  return { started: true, payload: { runId: started.id } };
}
