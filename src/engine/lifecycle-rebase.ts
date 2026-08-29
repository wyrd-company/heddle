// ---
// relationships:
//   implements: heddle
// ---

import { createHash } from "node:crypto";

import type { InstanceRecord } from "../persistence/index.js";
import { validateBlueprint } from "./blueprint.js";
import {
  BlueprintValidationError,
  RebaseTargetNotAwaitableError,
  RebaseTargetNotFoundError,
  TransitionConflictError,
} from "./errors.js";
import type { GitBlueprintStore } from "./git-blueprint-store.js";
import {
  readLifecycleContext,
  serializedContextForRebase,
  writeLifecycleContext,
} from "./lifecycle-state.js";
import type {
  LifecycleBlueprint,
  LifecycleEffect,
  LifecyclePersistence,
  RebaseLifecycleInput,
} from "./types.js";

interface LifecycleRebaseDependencies {
  blueprintStore: GitBlueprintStore;
  effects: Record<string, LifecycleEffect>;
  persistence: LifecyclePersistence;
}

interface LifecycleRebaseResult {
  blueprint: LifecycleBlueprint;
  record: InstanceRecord;
}

const raiseAttention = (
  persistence: LifecyclePersistence,
  input: RebaseLifecycleInput,
  blueprintBlobHash: string,
  blueprintPath: string,
  reason: "rebase-target-missing" | "rebase-target-not-awaitable",
): void => {
  const attentionId = createHash("sha256")
    .update(
      JSON.stringify([
        input.instanceId,
        blueprintBlobHash,
        input.targetState,
        reason,
      ]),
    )
    .digest("hex");
  const alreadyRaised = persistence
    .replayEvents(input.instanceId)
    .some(
      ({ payload, type }) =>
        type === "lifecycle:attention-required" &&
        typeof payload === "object" &&
        payload !== null &&
        !Array.isArray(payload) &&
        payload.attentionId === attentionId,
    );
  if (alreadyRaised) return;
  persistence.appendEvent(input.instanceId, "lifecycle:attention-required", {
    attentionId,
    blueprintBlobHash,
    blueprintPath,
    reason,
    targetState: input.targetState,
  });
};

export const rebaseLifecycle = async (
  dependencies: LifecycleRebaseDependencies,
  input: RebaseLifecycleInput,
): Promise<LifecycleRebaseResult> => {
  const { blueprintStore, effects, persistence } = dependencies;
  const record = persistence.getInstance(input.instanceId);
  if (record === undefined) {
    throw new Error(`Instance does not exist: ${input.instanceId}`);
  }
  const context = readLifecycleContext(record);
  if (context.serializedContext === null) {
    throw new TransitionConflictError(input.instanceId);
  }
  const previousBlueprint = await blueprintStore.read(
    context.blueprintBlobHash,
    context.blueprintPath,
  );
  const pinned = await blueprintStore.pin(context.blueprintPath);
  if (previousBlueprint.id !== pinned.blueprint.id) {
    throw new BlueprintValidationError(
      "Rebase blueprint artifact identity does not match the running instance",
    );
  }
  validateBlueprint(pinned.blueprint, effects);
  const target = pinned.blueprint.nodes.find(
    ({ id }) => id === input.targetState,
  );
  if (target === undefined) {
    raiseAttention(
      persistence,
      input,
      pinned.blobHash,
      pinned.path,
      "rebase-target-missing",
    );
    throw new RebaseTargetNotFoundError(input.instanceId, input.targetState);
  }
  if (target.uses !== "wait") {
    raiseAttention(
      persistence,
      input,
      pinned.blobHash,
      pinned.path,
      "rebase-target-not-awaitable",
    );
    throw new RebaseTargetNotAwaitableError(
      input.instanceId,
      input.targetState,
    );
  }
  const nextContext = {
    ...context,
    awaitingNodeIds: [input.targetState],
    blueprintBlobHash: pinned.blobHash,
    blueprintPath: pinned.path,
    pendingTransition: null,
    serializedContext: serializedContextForRebase(
      context.serializedContext,
      previousBlueprint,
      pinned.blueprint,
      input.targetState,
    ),
    status: "awaiting" as const,
  };
  const claimed = persistence.compareAndSwapInstance(
    input.instanceId,
    record.version,
    writeLifecycleContext(record.state, nextContext),
  );
  if (claimed === undefined) {
    throw new TransitionConflictError(input.instanceId);
  }
  return { blueprint: pinned.blueprint, record: claimed };
};
