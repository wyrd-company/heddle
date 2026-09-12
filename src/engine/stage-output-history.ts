// ---
// relationships:
//   implements: heddle
// ---

import type { FlowcraftEvent } from "flowcraft";

import type { JsonValue } from "../persistence/index.js";
import type {
  CompletedLifecycleOperation,
  LifecycleContextRecord,
  LifecyclePersistence,
} from "./types.js";

export type CompletedStageOutput = {
  output: Record<string, JsonValue>;
  stageId: string;
};

export type CompletedStageOperation = {
  operation: CompletedLifecycleOperation;
  stageId: string;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const resumeOutput = (
  executionId: string,
  events: FlowcraftEvent[],
): Record<string, JsonValue> => {
  const started = events.find(({ type }) => type === "node:start");
  const payload = record(started?.payload);
  const input = record(payload?.["input"]);
  if (input === undefined) {
    throw new Error(
      `Lifecycle execution ${JSON.stringify(executionId)} has no canonical resume output`,
    );
  }
  const output = { ...input };
  delete output["disposition"];
  delete output["dispositions"];
  return output as Record<string, JsonValue>;
};

const transitionNumber = (transitionId: string): number => {
  const value = Number(transitionId.slice(transitionId.lastIndexOf(":") + 1));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `Lifecycle transition ${JSON.stringify(transitionId)} has no canonical order`,
    );
  }
  return value;
};

export const readCompletedStageOutputs = async (
  persistence: Pick<LifecyclePersistence, "flowcraftHistory">,
  context: LifecycleContextRecord,
  completedStages: CompletedStageOperation[],
): Promise<CompletedStageOutput[]> => {
  const outputs: CompletedStageOutput[] = [];
  const recordedExecutionIds = new Set<string>();
  for (const executionId of context.executionIds) {
    if (typeof executionId !== "string" || executionId.trim() === "") {
      throw new Error("Lifecycle execution history contains an invalid ID");
    }
    recordedExecutionIds.add(executionId);
  }
  const consumedExecutionIds = new Set<string>();
  const ordered = [...completedStages].sort(
    (left, right) =>
      transitionNumber(left.operation.transitionId) -
      transitionNumber(right.operation.transitionId),
  );
  let previousTransitionNumber = 0;
  for (const { operation, stageId } of ordered) {
    const orderedTransitionNumber = transitionNumber(operation.transitionId);
    if (orderedTransitionNumber <= previousTransitionNumber) {
      throw new Error("Completed stage transitions do not have a unique order");
    }
    previousTransitionNumber = orderedTransitionNumber;
    for (const executionId of consumedExecutionIds) {
      if (!operation.executionIds.includes(executionId)) {
        throw new Error(
          `Stage ${JSON.stringify(stageId)} does not retain canonical lifecycle execution order`,
        );
      }
    }
    const transitionExecutionIds = operation.executionIds.filter(
      (executionId) => !consumedExecutionIds.has(executionId),
    );
    for (const executionId of operation.executionIds) {
      if (!recordedExecutionIds.has(executionId)) {
        throw new Error(
          `Stage ${JSON.stringify(stageId)} references unrecorded lifecycle execution ${JSON.stringify(executionId)}`,
        );
      }
      consumedExecutionIds.add(executionId);
    }
    const executionId = transitionExecutionIds.at(-1);
    if (executionId === undefined) {
      throw new Error(
        `Completed stage ${JSON.stringify(stageId)} has no canonical output`,
      );
    }
    const events = (await persistence.flowcraftHistory.replay(
      executionId,
    )) as FlowcraftEvent[];
    const output = resumeOutput(executionId, events);
    outputs.push({ output, stageId });
  }
  return outputs;
};
