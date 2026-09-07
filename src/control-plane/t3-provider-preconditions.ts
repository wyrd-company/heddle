// ---
// relationships:
//   implements: heddle
// ---

import { T3_RUNTIME_MODES } from "./provider-selection.js";

export type T3SessionLifecycle = "assistive" | "independent";

export type T3ProviderDispatchContext = {
  readonly cliVersion: string | null;
  readonly driver: string;
  readonly lifecycle: T3SessionLifecycle;
  readonly providerInstanceId: string;
};

export type T3ProviderPreconditionReason =
  | "provider-context-required"
  | "provider-instance-mismatch"
  | "provider-runtime-mode-mismatch";

export class T3ProviderPreconditionError extends Error {
  constructor(
    readonly reason: T3ProviderPreconditionReason,
    message: string,
  ) {
    super(message);
    this.name = "T3ProviderPreconditionError";
  }
}

export const assertT3ProviderDispatchPreconditions = (
  context: T3ProviderDispatchContext | undefined,
  runtimeMode: unknown,
  selectedProviderInstanceId?: unknown,
): void => {
  if (!context)
    throw new T3ProviderPreconditionError(
      "provider-context-required",
      "Cannot dispatch 'thread.turn.start': provider context is required",
    );

  if (
    selectedProviderInstanceId !== undefined &&
    selectedProviderInstanceId !== context.providerInstanceId
  )
    throw new T3ProviderPreconditionError(
      "provider-instance-mismatch",
      `Cannot dispatch 'thread.turn.start': selected provider instance '${String(selectedProviderInstanceId)}' does not match provider context '${context.providerInstanceId}'`,
    );

  if (
    typeof runtimeMode !== "string" ||
    !T3_RUNTIME_MODES.some((candidate) => candidate === runtimeMode)
  )
    throw new T3ProviderPreconditionError(
      "provider-runtime-mode-mismatch",
      `Cannot dispatch 'thread.turn.start': runtime mode must be one of '${T3_RUNTIME_MODES.join("', '")}'`,
    );
};
