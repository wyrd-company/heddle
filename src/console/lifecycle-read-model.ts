// ---
// relationships:
//   implements: heddle
//   references: flowcraft-gate
// ---

import type { FlowcraftEvent } from "flowcraft";

import type { LifecycleBlueprint } from "../engine/index.js";
import type { JsonValue } from "../persistence/index.js";
import type { ConsoleLifecycleSnapshot } from "./types.js";

export interface ConsoleLifecycleReadInput {
  afterSequence: number;
  blueprint: LifecycleBlueprint;
  blueprintBlobHash: string;
  blueprintPath: string;
  currentStageIds: string[];
  executionHistories: Array<{
    events: FlowcraftEvent[];
    executionId: string;
  }>;
  instanceId: string;
  rebase: {
    targetBlueprintBlobHash: string;
    targetStateIds: string[];
  };
  status: string;
  taskId: number;
}

const duplicate = (values: string[]): string | undefined => {
  const seen = new Set<string>();
  return values.find((value) => {
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  });
};

export const buildConsoleLifecycleSnapshot = (
  input: ConsoleLifecycleReadInput,
): ConsoleLifecycleSnapshot => {
  if (!Number.isSafeInteger(input.taskId) || input.taskId < 1) {
    throw new TypeError("Lifecycle task id must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) {
    throw new TypeError(
      "Lifecycle event cursor must be a non-negative safe integer",
    );
  }
  if (input.instanceId.trim() === "") {
    throw new TypeError("Lifecycle instance id must not be empty");
  }
  if (
    input.blueprintBlobHash.trim() === "" ||
    input.blueprintPath.trim() === ""
  ) {
    throw new TypeError("Lifecycle blueprint identity must be complete");
  }

  const nodeIds = input.blueprint.nodes.map(({ id }) => id);
  const duplicateNode = duplicate(nodeIds);
  if (duplicateNode !== undefined) {
    throw new TypeError(`Lifecycle blueprint repeats node ${duplicateNode}`);
  }
  const knownNodes = new Set(nodeIds);
  for (const stageId of input.currentStageIds) {
    if (!knownNodes.has(stageId)) {
      throw new TypeError(
        `Lifecycle stage is absent from pinned blueprint: ${stageId}`,
      );
    }
  }
  for (const edge of input.blueprint.edges) {
    if (!knownNodes.has(edge.source) || !knownNodes.has(edge.target)) {
      throw new TypeError(
        "Lifecycle edge names a node outside the pinned blueprint",
      );
    }
  }
  const executionIds = input.executionHistories.map(
    ({ executionId }) => executionId,
  );
  const duplicateExecution = duplicate(executionIds);
  if (duplicateExecution !== undefined) {
    throw new TypeError(
      `Lifecycle history repeats execution ${duplicateExecution}`,
    );
  }

  const orderedEvents = input.executionHistories.flatMap(
    ({ events, executionId }) =>
      events.map((event) => ({ event, executionId })),
  );
  const nextSequence = orderedEvents.length;
  if (input.afterSequence > nextSequence) {
    throw new TypeError("Lifecycle event cursor is ahead of persisted history");
  }
  const nodeEventTypes = new Set(["node:error", "node:finish", "node:start"]);
  for (const { event } of orderedEvents) {
    if (event.type.trim() === "") {
      throw new TypeError("Lifecycle event type must not be empty");
    }
    if (!nodeEventTypes.has(event.type)) continue;
    const payload = event.payload as Record<string, unknown>;
    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof payload["nodeId"] !== "string" ||
      !knownNodes.has(payload["nodeId"])
    ) {
      throw new TypeError(
        "Lifecycle node event disagrees with pinned blueprint",
      );
    }
  }

  return {
    blueprint: {
      blobHash: input.blueprintBlobHash,
      edges: input.blueprint.edges.map(({ condition, source, target }) => ({
        ...(condition === undefined ? {} : { condition }),
        source,
        target,
      })),
      id: input.blueprint.id,
      nodes: input.blueprint.nodes.map(({ id, uses }) => ({ id, uses })),
      path: input.blueprintPath,
    },
    currentStageIds: [...input.currentStageIds],
    events: orderedEvents
      .map(({ event, executionId }, index) => ({
        executionId,
        payload: event.payload as JsonValue,
        sequence: index + 1,
        type: event.type,
      }))
      .filter(({ sequence }) => sequence > input.afterSequence),
    instanceId: input.instanceId,
    nextSequence,
    rebase: {
      available:
        input.status === "awaiting" &&
        input.blueprintBlobHash !== input.rebase.targetBlueprintBlobHash,
      targetBlueprintBlobHash: input.rebase.targetBlueprintBlobHash,
      targetStateIds: [...input.rebase.targetStateIds],
    },
    status: input.status,
    taskId: input.taskId,
  };
};
