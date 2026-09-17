// ---
// relationships:
//   implements: engine-and-run-model
// ---
import type { NodeDefinition, NodeFunction } from "flowcraft";
import type { RunStore } from "./store.js";
import { DurableRuntime, DispatchHeld, resolveValues } from "./runtime.js";
import type {
  AwaitingDetails,
  Data,
  EngineNode,
  EngineOptions,
  Run,
} from "./types.js";
import { duration } from "./timing.js";

export function bindNode(
  store: RunStore,
  runtime: DurableRuntime,
  run: Run,
  definition: NodeDefinition,
  implementation: EngineNode | undefined,
  clock: () => number,
  beforeNode?: EngineOptions["beforeNode"],
): NodeFunction<Data, Data, unknown, unknown> {
  return async (native) => {
    if (store.get(run.id).paused)
      throw new DispatchHeld("Dispatch held by instance pause");
    const nodeId = definition.id;
    const visit = store.beginVisit(run.id, nodeId);
    store.event(run.id, "node-start", { nodeId, visit });
    const context = await native.context.toJSON();
    const params = (await resolveValues(
      definition.params ?? {},
      context,
    )) as Data;
    const deadline = duration(params["deadline"]);
    const inactivity = duration(params["inactivity"]);
    let awaiting: AwaitingDetails | undefined;
    const pause = async (details: AwaitingDetails) => {
      awaiting = details;
      runtime.pausing.add(nodeId);
      await native.dependencies.workflowState.markAsAwaiting(nodeId, details);
    };
    const effectKey = JSON.stringify([run.id, nodeId, visit]);
    let output: unknown;
    const nodeContext = {
      run,
      nodeId,
      visit,
      effectKey,
      params,
      input: native.input,
      context,
      await: pause,
    };
    await beforeNode?.(nodeContext, definition);
    if (awaiting) {
      // The adapter holds dispatch until its attention is resolved.
    } else if (definition.uses === "child-run") {
      if (typeof params["blueprint"] !== "string")
        throw new Error("child-run requires blueprint");
      await pause({
        kind: "child-run",
        childRunId: effectKey,
        blueprint: params["blueprint"],
        inputs: params["inputs"] ?? {},
        outputs: params["outputs"],
      });
    } else if (definition.uses === "sleep") {
      const deadline = duration(params["duration"]);
      if (deadline === undefined) throw new Error("sleep requires duration");
      await pause({ kind: "sleep", deadline });
    } else if (definition.uses === "wait") {
      await pause({ kind: "wait" });
    } else {
      if (!implementation)
        throw new Error(`Node type is not registered: ${definition.uses}`);
      output = await implementation({
        run,
        nodeId,
        visit,
        effectKey,
        params,
        input: native.input,
        context,
        await: pause,
      });
    }
    // Node-owned shared context writes are part of the same durable checkpoint.
    for (const [key, value] of Object.entries(context)) {
      if (key === "_awaitingNodeIds" || key === "_awaitingDetails") continue;
      await native.context.set(key, value);
    }
    if (awaiting) await native.context.delete(`_outputs.${nodeId}`);
    const snapshot = await native.context.toJSON();
    if (awaiting) {
      if (deadline !== undefined) awaiting.deadline = deadline;
      if (inactivity !== undefined) awaiting.inactivity = inactivity;
      snapshot["_awaitingNodeIds"] =
        native.dependencies.workflowState.getAwaitingNodeIds();
      snapshot["_awaitingDetails"] = {
        ...(snapshot["_awaitingDetails"] as Data),
        [nodeId]: awaiting,
      };
    }
    store.transaction(() => {
      const checkpoint = awaiting
        ? { context: snapshot, frontier: runtime.pending }
        : {
            context: {
              ...snapshot,
              _awaitingNodeIds: [
                ...native.dependencies.workflowState.getAwaitingNodeIds(),
                nodeId,
              ],
              _awaitingDetails: {
                ...(snapshot["_awaitingDetails"] as Data),
                [nodeId]: { kind: "checkpoint" },
              },
            },
            frontier: runtime.pending,
            nodeId,
            output: output ?? null,
          };
      store.save(run.id, snapshot, checkpoint, "running");
      store.finishVisit(run.id, nodeId);
      store.event(run.id, "node-end", {
        nodeId,
        visit,
        output: output ?? null,
      });
      if (awaiting) {
        store.recordAwaiting(
          { runId: run.id, nodeId, visit, details: awaiting },
          clock(),
        );
        store.event(run.id, "pause", { nodeId, visit, details: awaiting });
      }
    });
    return { output: output ?? null };
  };
}
