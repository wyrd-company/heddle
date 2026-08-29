// ---
// relationships:
//   implements: heddle
// ---

import type { WorkflowStatus } from "flowcraft";

import type {
  InstanceRecord,
  InstanceState,
  JsonValue,
} from "../persistence/index.js";
import type {
  CompletedLifecycleOperation,
  LifecycleAttention,
  LifecycleContextRecord,
  LifecyclePersistence,
  ResumeLifecycleInput,
  StartLifecycleInput,
  LifecycleBlueprint,
} from "./types.js";

const asJsonValue = (value: unknown): JsonValue => value as JsonValue;

export const readLifecycleContext = (
  record: InstanceRecord,
): LifecycleContextRecord => {
  const value = record.state.flowcraftContext;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("blueprintBlobHash" in value) ||
    typeof value.blueprintBlobHash !== "string" ||
    !("blueprintPath" in value) ||
    typeof value.blueprintPath !== "string" ||
    !("completedOperations" in value) ||
    typeof value.completedOperations !== "object" ||
    value.completedOperations === null ||
    Array.isArray(value.completedOperations) ||
    !("executionIds" in value) ||
    !Array.isArray(value.executionIds) ||
    !("awaitingNodeIds" in value) ||
    !Array.isArray(value.awaitingNodeIds) ||
    !("pendingAttentions" in value) ||
    !Array.isArray(value.pendingAttentions) ||
    !("nextTransitionNumber" in value) ||
    typeof value.nextTransitionNumber !== "number"
  ) {
    throw new Error(
      `Instance ${JSON.stringify(record.instanceId)} does not contain lifecycle engine state`,
    );
  }
  return value as unknown as LifecycleContextRecord;
};

export const writeLifecycleContext = (
  state: InstanceState,
  context: LifecycleContextRecord,
): InstanceState => ({
  ...state,
  flowcraftContext: asJsonValue(context),
});

export const initialInstanceState = (
  input: StartLifecycleInput,
  context: LifecycleContextRecord,
): InstanceState => ({
  correlationTokens: input.state?.correlationTokens ?? {},
  flowcraftContext: asJsonValue(context),
  handoffs: input.state?.handoffs ?? [],
  todoState: input.state?.todoState ?? null,
});

const canonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
};

export const resumeOperationFingerprint = (
  input: ResumeLifecycleInput,
): string =>
  canonicalJson({
    disposition: input.disposition,
    output: input.output ?? {},
  });

export const completedOperationForTransition = (
  context: LifecycleContextRecord,
  transitionId: string,
): CompletedLifecycleOperation | undefined =>
  Object.values(context.completedOperations).find(
    (operation) => operation.transitionId === transitionId,
  );

const predecessorIds = (
  blueprint: LifecycleBlueprint,
  targetState: string,
): Set<string> => {
  const predecessors = new Set<string>();
  const pending = [targetState];
  while (pending.length > 0) {
    const target = pending.pop();
    if (target === undefined) continue;
    for (const { source } of blueprint.edges.filter(
      ({ target: edgeTarget }) => edgeTarget === target,
    )) {
      if (source === targetState || predecessors.has(source)) continue;
      predecessors.add(source);
      pending.push(source);
    }
  }
  return predecessors;
};

export const serializedContextForRebase = (
  serializedContext: string,
  previousBlueprint: LifecycleBlueprint,
  nextBlueprint: LifecycleBlueprint,
  targetState: string,
): string => {
  const previous = JSON.parse(serializedContext) as Record<string, unknown>;
  const rebased = { ...previous };
  const nodeIds = new Set([
    ...previousBlueprint.nodes.map(({ id }) => id),
    ...nextBlueprint.nodes.map(({ id }) => id),
  ]);
  for (const nodeId of nodeIds) {
    delete rebased[`_outputs.${nodeId}`];
    delete rebased[nodeId];
  }
  for (const nodeId of predecessorIds(nextBlueprint, targetState)) {
    const output = previous[`_outputs.${nodeId}`] ?? null;
    rebased[`_outputs.${nodeId}`] = output;
    rebased[nodeId] = previous[nodeId] ?? output;
  }
  delete rebased._executionId;
  rebased._awaitingNodeIds = [targetState];
  rebased._awaitingDetails = {
    [targetState]: { reason: "external_event" },
  };
  return JSON.stringify(rebased);
};

const withCompletedOperation = (
  completedOperations: Record<string, CompletedLifecycleOperation>,
  operationId: string,
  operation: CompletedLifecycleOperation,
): Record<string, CompletedLifecycleOperation> => ({
  ...completedOperations,
  [operationId]: operation,
});

export const persistExecution = (
  persistence: LifecyclePersistence,
  instanceId: string,
  pendingTransitionId: string,
  executionId: string | undefined,
  completion?: {
    awaitingNodeIds: string[];
    serializedContext: string;
    status: WorkflowStatus;
  },
  attention?: LifecycleAttention,
): LifecycleContextRecord => {
  while (true) {
    const current = persistence.getInstance(instanceId);
    if (current === undefined) {
      throw new Error(`Instance does not exist: ${instanceId}`);
    }
    const currentContext = readLifecycleContext(current);
    const executionIds =
      executionId === undefined ||
      currentContext.executionIds.includes(executionId)
        ? currentContext.executionIds
        : [...currentContext.executionIds, executionId];
    const completesCurrentTransition =
      completion !== undefined &&
      currentContext.pendingTransition?.id === pendingTransitionId;
    const pendingAttentions =
      attention === undefined ||
      currentContext.pendingAttentions.some(
        ({ attentionId }) => attentionId === attention.attentionId,
      )
        ? currentContext.pendingAttentions
        : [...currentContext.pendingAttentions, attention];
    let completedOperations = { ...currentContext.completedOperations };
    const pendingOperation = completesCurrentTransition
      ? currentContext.pendingTransition
      : null;
    if (
      pendingOperation !== null &&
      pendingOperation.operationId !== null &&
      pendingOperation.requestFingerprint !== null &&
      completion !== undefined
    ) {
      completedOperations = withCompletedOperation(
        completedOperations,
        pendingOperation.operationId,
        {
          awaitingNodeIds: [...completion.awaitingNodeIds],
          executionIds: [...executionIds],
          requestFingerprint: pendingOperation.requestFingerprint,
          status: completion.status,
          transitionId: pendingTransitionId,
        },
      );
    } else if (executionId !== undefined) {
      const completedEntry = Object.entries(completedOperations).find(
        ([, operation]) => operation.transitionId === pendingTransitionId,
      ) as [string, CompletedLifecycleOperation] | undefined;
      if (completedEntry !== undefined) {
        const [operationId, operation] = completedEntry;
        completedOperations = withCompletedOperation(
          completedOperations,
          operationId,
          {
            ...operation,
            executionIds: operation.executionIds.includes(executionId)
              ? operation.executionIds
              : [...operation.executionIds, executionId],
          },
        );
      }
    }
    if (
      executionIds === currentContext.executionIds &&
      pendingAttentions === currentContext.pendingAttentions &&
      !completesCurrentTransition
    ) {
      return currentContext;
    }
    const nextContext: LifecycleContextRecord = {
      ...currentContext,
      completedOperations,
      executionIds,
      pendingAttentions,
      ...(completesCurrentTransition
        ? { ...completion, pendingTransition: null }
        : {}),
    };
    const claimed = persistence.compareAndSwapInstance(
      instanceId,
      current.version,
      writeLifecycleContext(current.state, nextContext),
    );
    if (claimed !== undefined) return readLifecycleContext(claimed);
  }
};
