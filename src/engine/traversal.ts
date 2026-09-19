// ---
// relationships:
//   implements: engine-and-run-model
//   references: flowcraft-stage-semantics
// ---
import {
  GraphTraverser,
  executeBatch,
  processResults,
  type IOrchestrator,
  type NodeExecutor,
} from "flowcraft";
import { enableCycleReentry } from "./cycle-reentry.js";
import type { DurableRuntime } from "./runtime.js";
import type { RunStore } from "./store.js";
import type { Checkpoint, Data } from "./types.js";

/** Persist Flowcraft's unfinished frontier rather than infer it from pauses. */
export class DurableTraversal implements IOrchestrator {
  constructor(
    private readonly store: RunStore,
    private readonly runId: string,
    private readonly runtime: DurableRuntime,
    private readonly checkpoint: Checkpoint,
  ) {}
  async run(...[context, initial]: Parameters<IOrchestrator["run"]>) {
    const typed = context as unknown as Parameters<
      DurableRuntime["getExecutorForNode"]
    >[1];
    const { state, blueprint } = context;
    let traverser = initial;
    enableCycleReentry(traverser);
    if (
      this.checkpoint.frontier !== undefined ||
      this.checkpoint.nodeId !== undefined
    ) {
      if (this.checkpoint.nodeId !== undefined) {
        await state.addCompletedNode(
          this.checkpoint.nodeId,
          this.checkpoint.output,
        );
        state.clearAwaiting(this.checkpoint.nodeId);
      }
      traverser = GraphTraverser.fromState(blueprint, state);
      enableCycleReentry(traverser);
      traverser.clearFrontier();
      for (const id of this.checkpoint.frontier ?? [])
        traverser.addToFrontier(id);
      if (this.checkpoint.nodeId !== undefined) {
        const result = { output: this.checkpoint.output };
        const next = await this.runtime.determineNextNodes(
          blueprint,
          this.checkpoint.nodeId,
          result,
          state.getContext(),
          context.executionId,
        );
        for (const { node, edge } of next)
          await this.runtime.applyEdgeTransform(
            edge,
            result,
            node,
            state.getContext(),
            traverser.getAllPredecessors(),
            context.executionId,
          );
        traverser.markNodeCompleted(
          this.checkpoint.nodeId,
          result,
          next.map(({ node }) => node),
        );
      }
    }
    let ready = traverser.getReadyNodes();
    while (ready.length > 0) {
      const node = ready.shift();
      if (!node) break;
      this.runtime.pending = ready.map(({ nodeId }) => nodeId);
      const before = (await state.getContext().toJSON()) as Data;
      this.store.save(
        this.runId,
        before,
        {
          context: before,
          frontier: [node.nodeId, ...this.runtime.pending],
        },
        "running",
      );
      const results = await executeBatch(
        [node],
        blueprint,
        state,
        (id) =>
          this.runtime.getExecutorForNode(id, typed) as NodeExecutor<
            Data,
            Data
          >,
        this.runtime,
        1,
      );
      const result = results[0];
      if (
        this.runtime.pausing.has(node.nodeId) &&
        result?.status === "fulfilled" &&
        result.value.executionResult.status === "success"
      ) {
        // A paused visit is unfinished and cannot satisfy a join.
        traverser.resetNodeCompletion(node.nodeId);
        this.runtime.pausing.delete(node.nodeId);
      } else {
        await processResults(
          results,
          traverser,
          state,
          this.runtime,
          blueprint,
          context.executionId,
        );
      }
      if (state.getErrors().length > 0) break;
      ready = [
        ...new Map(
          [...ready, ...traverser.getReadyNodes()].map((item) => [
            item.nodeId,
            item,
          ]),
        ).values(),
      ];
    }
    const result = await state.toResult(
      context.services.serializer,
      context.executionId,
    );
    result.status = state.getStatus(ready.length === 0);
    return result;
  }
}
