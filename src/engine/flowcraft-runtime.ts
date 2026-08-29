// ---
// relationships:
//   implements: heddle
// ---

import {
  FlowRuntime,
  PersistentEventBusAdapter,
  type FlowcraftEvent,
  type IEventStore,
  type NodeFunction,
  type WorkflowResult,
} from "flowcraft";

import type { FlowcraftHistory } from "../persistence/index.js";
import { internalNodeIdParameter } from "./blueprint.js";
import { BlueprintValidationError } from "./errors.js";
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
  ...blueprint,
  edges: blueprint.edges.map((edge) => ({ ...edge })),
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
  const conditionalEdgeKeysBySource = new Map<string, Set<string>>();
  for (const edge of blueprint.edges) {
    if (edge.condition === undefined) continue;
    if (blueprint.nodes.find(({ id }) => id === edge.source)?.uses === "wait") {
      continue;
    }
    const edgeKeys = conditionalEdgeKeysBySource.get(edge.source) ?? new Set();
    edgeKeys.add(JSON.stringify([edge.target, edge.condition]));
    conditionalEdgeKeysBySource.set(edge.source, edgeKeys);
  }
  for (const [source, edgeKeys] of conditionalEdgeKeysBySource) {
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
      if (skippedEdgeCount >= edgeKeys.size) return false;
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
  const registry: Record<string, NodeFunction> = {};
  for (const effectName of new Set(
    blueprint.nodes
      .filter(({ uses }) => uses !== "wait")
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
          context,
          idempotencyKey: JSON.stringify([pending.id, nodeId]),
          input,
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
    store: (event, executionId) => history.append(event, executionId),
  };
  return new FlowRuntime({
    eventBus: new PersistentEventBusAdapter(eventStore),
    registry,
  });
};
