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
  LifecycleContextRecord,
  LifecyclePersistence,
  ResumeLifecycleInput,
  StartLifecycleInput,
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
      !completesCurrentTransition
    ) {
      return currentContext;
    }
    const nextContext: LifecycleContextRecord = {
      ...currentContext,
      completedOperations,
      executionIds,
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
