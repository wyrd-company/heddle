// ---
// relationships:
//   implements: heddle
// ---

import type {
  InstanceRecord,
  InstanceState,
  JsonValue,
} from "../persistence/index.js";
import type {
  LifecycleContextRecord,
  LifecyclePersistence,
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

export const persistExecution = (
  persistence: LifecyclePersistence,
  instanceId: string,
  pendingTransitionId: string,
  executionId: string | undefined,
  completion?: Pick<
    LifecycleContextRecord,
    "awaitingNodeIds" | "serializedContext" | "status"
  >,
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
    if (
      executionIds === currentContext.executionIds &&
      !completesCurrentTransition
    ) {
      return currentContext;
    }
    const nextContext: LifecycleContextRecord = {
      ...currentContext,
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
