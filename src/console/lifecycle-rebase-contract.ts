// ---
// relationships:
//   implements: heddle
// ---

import type {
  ConsoleLifecycleRebaseRequest,
  ConsoleLifecycleSnapshot,
} from "./types.js";

const gitObjectId = /^[0-9a-f]{40,64}$/;

export class ConsoleLifecycleActionsUnavailableError extends Error {}

export class ConsoleLifecycleRebaseConflictError extends Error {}

const requiredString = (
  value: unknown,
  name: string,
  maximumLength = 128,
): string => {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > maximumLength
  ) {
    throw new TypeError(
      `${name} must be a non-empty string of at most ${maximumLength} characters`,
    );
  }
  return value;
};

export const parseConsoleLifecycleRebaseRequest = (
  value: unknown,
): ConsoleLifecycleRebaseRequest => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("lifecycle rebase request must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const allowed = new Set([
    "expectedInstanceId",
    "expectedPinnedBlobHash",
    "expectedTargetBlobHash",
    "targetState",
  ]);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) {
    throw new TypeError("lifecycle rebase request contains unknown fields");
  }
  const expectedPinnedBlobHash = requiredString(
    candidate["expectedPinnedBlobHash"],
    "expected pinned blueprint blob hash",
  );
  const expectedTargetBlobHash = requiredString(
    candidate["expectedTargetBlobHash"],
    "expected target blueprint blob hash",
  );
  if (
    !gitObjectId.test(expectedPinnedBlobHash) ||
    !gitObjectId.test(expectedTargetBlobHash)
  ) {
    throw new TypeError(
      "lifecycle rebase blueprint hashes must be Git object IDs",
    );
  }
  return {
    expectedInstanceId: requiredString(
      candidate["expectedInstanceId"],
      "expected lifecycle instance id",
    ),
    expectedPinnedBlobHash,
    expectedTargetBlobHash,
    targetState: requiredString(candidate["targetState"], "target state"),
  };
};

export const assertConsoleLifecycleRebaseCurrent = (
  lifecycle: ConsoleLifecycleSnapshot,
  request: ConsoleLifecycleRebaseRequest,
): void => {
  if (lifecycle.instanceId !== request.expectedInstanceId) {
    throw new ConsoleLifecycleRebaseConflictError(
      "Lifecycle instance identity changed before rebase",
    );
  }
  if (lifecycle.blueprint.blobHash !== request.expectedPinnedBlobHash) {
    throw new ConsoleLifecycleRebaseConflictError(
      "Pinned lifecycle blueprint changed before rebase",
    );
  }
  if (
    lifecycle.rebase.targetBlueprintBlobHash !== request.expectedTargetBlobHash
  ) {
    throw new ConsoleLifecycleRebaseConflictError(
      "Upstream lifecycle blueprint changed before rebase",
    );
  }
  if (!lifecycle.rebase.available) {
    throw new ConsoleLifecycleRebaseConflictError(
      "Lifecycle instance is already on the current upstream blueprint",
    );
  }
  if (!lifecycle.rebase.targetStateIds.includes(request.targetState)) {
    throw new ConsoleLifecycleRebaseConflictError(
      `Lifecycle state '${request.targetState}' is not offered by the current upstream blueprint`,
    );
  }
};
