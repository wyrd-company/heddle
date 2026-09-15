// ---
// relationships:
//   implements: heddle
// ---

import {
  FlowRuntime,
  PersistentEventBusAdapter,
  type ContextImplementation,
  type FlowcraftEvent,
  type IEventStore,
  type NodeFunction,
  type WorkflowResult,
} from "flowcraft";

import { errorDetail } from "../error-details.js";
import type { FlowcraftHistory } from "../persistence/index.js";
import { internalNodeIdParameter } from "./blueprint.js";
import {
  edgeRoutingKey,
  evaluateOutgoingConditions,
  effectiveCondition,
  mergeRouting,
  routedBlueprint,
} from "./edge-conditions.js";
import { BlueprintValidationError } from "./errors.js";
import {
  lifecycleContextKey,
  recordNodeFinish,
} from "./lifecycle-projection.js";
import { isAwaitingNode, questionNodeUse } from "./question-node.js";
import type {
  ExpectedLandings,
  LifecycleBlueprint,
  LifecycleEffect,
  PendingTransition,
} from "./types.js";

export const runtimeContext = (serialized: string): Record<string, unknown> => {
  const value = JSON.parse(serialized) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Flowcraft serialized context must be an object");
  }
  return value as Record<string, unknown>;
};

export const awaitingNodeIdsFrom = (serialized: string): string[] => {
  const value = runtimeContext(serialized)._awaitingNodeIds;
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").sort()
    : [];
};

export const executionIdFrom = (serialized: string): string | undefined => {
  const value = runtimeContext(serialized)._executionId;
  return typeof value === "string" && value !== "" ? value : undefined;
};

export const prepareRuntimeBlueprint = (
  blueprint: LifecycleBlueprint,
): LifecycleBlueprint => ({
  ...routedBlueprint(blueprint),
  nodes: blueprint.nodes.map((node) => ({
    ...node,
    params: {
      ...node.params,
      [internalNodeIdParameter]: node.id,
    },
  })),
});

export const landedAsExpected = (
  result: WorkflowResult,
  expected: ExpectedLandings,
  blueprint: LifecycleBlueprint,
  events: FlowcraftEvent[],
): boolean => {
  const conditionalEdgesBySource = new Map<
    string,
    { edgeKeys: Set<string>; exclusive: boolean }
  >();
  for (const edge of blueprint.edges) {
    if (effectiveCondition(blueprint, edge) === undefined) continue;
    const source = blueprint.nodes.find(({ id }) => id === edge.source);
    if (source !== undefined && isAwaitingNode(source)) continue;
    const conditional = conditionalEdgesBySource.get(edge.source) ?? {
      edgeKeys: new Set<string>(),
      exclusive: false,
    };
    conditional.edgeKeys.add(JSON.stringify([edge.target, edge.condition]));
    conditional.exclusive ||= edge.disposition !== undefined;
    conditionalEdgesBySource.set(edge.source, conditional);
  }
  for (const [source, { edgeKeys, exclusive }] of conditionalEdgesBySource) {
    const finishIndexes = events.flatMap((event, index) =>
      event.type === "node:finish" && event.payload.nodeId === source
        ? [index]
        : [],
    );
    for (const [finishIndexOffset, finishIndex] of finishIndexes.entries()) {
      const nextFinishIndex = finishIndexes[finishIndexOffset + 1];
      const skippedEdgeCount = events
        .slice(finishIndex + 1, nextFinishIndex)
        .filter(
          (event) =>
            event.type === "node:skipped" && event.payload.nodeId === source,
        ).length;
      if (
        (exclusive && skippedEdgeCount !== edgeKeys.size - 1) ||
        (!exclusive && skippedEdgeCount >= edgeKeys.size)
      ) {
        return false;
      }
    }
  }
  if (result.status === "awaiting") {
    const actual = awaitingNodeIdsFrom(result.serializedContext);
    return expected.some(
      ({ awaitingNodeIds, terminalNodeIds }) =>
        terminalNodeIds.length === 0 &&
        JSON.stringify(actual) === JSON.stringify(awaitingNodeIds),
    );
  }
  if (result.status !== "completed") return false;
  const context = runtimeContext(result.serializedContext);
  const possibleTerminalNodeIds = [
    ...new Set(expected.flatMap(({ terminalNodeIds }) => terminalNodeIds)),
  ].sort();
  const actualTerminalNodeIds = possibleTerminalNodeIds.filter((nodeId) =>
    Object.hasOwn(context, `_outputs.${nodeId}`),
  );
  return expected.some(
    ({ awaitingNodeIds, terminalNodeIds }) =>
      awaitingNodeIds.length === 0 &&
      JSON.stringify(actualTerminalNodeIds) === JSON.stringify(terminalNodeIds),
  );
};

export const createLifecycleRuntime = (
  blueprint: LifecycleBlueprint,
  effects: Record<string, LifecycleEffect>,
  history: FlowcraftHistory,
  pending: PendingTransition,
): FlowRuntime<Record<string, unknown>, Record<string, never>> => {
  const registry: Record<string, NodeFunction> = {
    // A question node waits like a wait node; the production layer asks the
    // role and resumes the lifecycle with the answer as this node's output.
    [questionNodeUse]: async ({ dependencies, params }) => {
      const nodeId = params[internalNodeIdParameter];
      if (typeof nodeId !== "string") {
        throw new Error("Lifecycle node id is missing");
      }
      await dependencies.workflowState.markAsAwaiting(nodeId, {
        reason: "external_event",
      });
      return { output: undefined };
    },
  };
  for (const effectName of new Set(
    blueprint.nodes
      .filter((node) => !isAwaitingNode(node))
      .map(({ uses }) => uses),
  )) {
    const effect = effects[effectName];
    if (effect === undefined) {
      throw new BlueprintValidationError(
        `Missing lifecycle effect ${JSON.stringify(effectName)}`,
      );
    }
    registry[effectName] = async ({ context, input, params }) => {
      const nodeId = params[internalNodeIdParameter];
      if (typeof nodeId !== "string") {
        throw new Error("Lifecycle node id is missing");
      }
      const effectParams = { ...params };
      delete effectParams[internalNodeIdParameter];
      return {
        output: await effect({
          blueprint,
          context,
          idempotencyKey: JSON.stringify([pending.id, nodeId]),
          input,
          nodeId,
          params: effectParams,
        }),
      };
    };
  }
  const eventStore: IEventStore = {
    retrieve: (executionId) =>
      history.replay(executionId) as Promise<FlowcraftEvent[]>,
    retrieveMultiple: (executionIds) =>
      history.replayMultiple(executionIds) as Promise<
        Map<string, FlowcraftEvent[]>
      >,
    store: (event, executionId) =>
      history.append(
        (event.type === "node:error"
          ? {
              ...event,
              payload: {
                ...event.payload,
                error: errorDetail(event.payload.error),
              },
            }
          : event) as FlowcraftEvent,
        executionId,
      ),
  };
  // Parallel branches finish concurrently and each finish reads, extends, and
  // writes back the projection and the routing slots. The chain runs one
  // finish at a time so no branch overwrites another's visits, outputs, or
  // routing.
  let finishChain: Promise<void> = Promise.resolve();
  const recordFinish = async (
    context: ContextImplementation<Record<string, unknown>>,
    nodeId: string,
    result: { output?: unknown },
  ): Promise<void> => {
    const data = recordNodeFinish(
      await context.toJSON(),
      nodeId,
      result.output,
    );
    await context.set(lifecycleContextKey, data[lifecycleContextKey]);
    const routing = await evaluateOutgoingConditions(blueprint, nodeId, {
      ...data,
      result,
    });
    await context.set(
      edgeRoutingKey,
      mergeRouting(data, routing)[edgeRoutingKey],
    );
  };
  return new FlowRuntime({
    eventBus: new PersistentEventBusAdapter(eventStore),
    middleware: [
      {
        // Heddle evaluates the authored JSONata conditions of the finished
        // node's outgoing edges here, before Flowcraft routes on the booleans.
        // A resumed wait node never executes, so the engine routes it before
        // calling resume.
        afterNode: (context, nodeId, result, error) => {
          if (error !== undefined || result === undefined) return;
          const node = blueprint.nodes.find(({ id }) => id === nodeId);
          if (node !== undefined && isAwaitingNode(node)) return;
          const finish = finishChain.then(() =>
            recordFinish(context, nodeId, result),
          );
          finishChain = finish.catch(() => undefined);
          return finish;
        },
      },
    ],
    registry,
  });
};
