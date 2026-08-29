// ---
// relationships:
//   implements: heddle
//   references: cursor-headless
// ---

import configuredPreconditions from "./t3-provider-preconditions.json" with { type: "json" };

export type T3ProviderVersionPreconditions = {
  readonly questionToolAvailable: boolean;
  readonly runtimeMode: string;
};

export type T3ProviderPreconditionTable = Readonly<
  Record<string, Readonly<Record<string, T3ProviderVersionPreconditions>>>
>;

export type T3SessionLifecycle = "assistive" | "independent";

export type T3ProviderDispatchContext = {
  readonly cliVersion: string;
  readonly driver: string;
  readonly lifecycle: T3SessionLifecycle;
};

export type T3ProviderPreconditionReason =
  | "provider-not-configured"
  | "provider-cli-version-not-configured"
  | "provider-context-required"
  | "provider-driver-mismatch"
  | "provider-runtime-mode-mismatch"
  | "provider-question-tool-unavailable";

export class T3ProviderPreconditionError extends Error {
  constructor(
    readonly reason: T3ProviderPreconditionReason,
    message: string,
  ) {
    super(message);
    this.name = "T3ProviderPreconditionError";
  }
}

export const t3ProviderPreconditions: T3ProviderPreconditionTable =
  configuredPreconditions.providers;

export const assertT3ProviderDispatchPreconditions = (
  table: T3ProviderPreconditionTable,
  context: T3ProviderDispatchContext | undefined,
  runtimeMode: unknown,
  selectedDriver?: unknown,
): void => {
  if (!context)
    throw new T3ProviderPreconditionError(
      "provider-context-required",
      "Cannot dispatch 'thread.turn.start': provider context is required",
    );

  if (selectedDriver !== undefined && selectedDriver !== context.driver)
    throw new T3ProviderPreconditionError(
      "provider-driver-mismatch",
      `Cannot dispatch 'thread.turn.start': selected provider '${String(selectedDriver)}' does not match provider context '${context.driver}'`,
    );

  const provider = table[context.driver];
  if (!provider)
    throw new T3ProviderPreconditionError(
      "provider-not-configured",
      `Cannot dispatch 'thread.turn.start': provider '${context.driver}' is not configured`,
    );

  const version = provider[context.cliVersion];
  if (!version)
    throw new T3ProviderPreconditionError(
      "provider-cli-version-not-configured",
      `Cannot dispatch 'thread.turn.start': provider '${context.driver}' CLI version '${context.cliVersion}' is not configured`,
    );

  if (runtimeMode !== version.runtimeMode)
    throw new T3ProviderPreconditionError(
      "provider-runtime-mode-mismatch",
      `Cannot dispatch 'thread.turn.start': provider '${context.driver}' CLI version '${context.cliVersion}' requires runtime mode '${version.runtimeMode}'`,
    );

  if (context.lifecycle === "assistive" && !version.questionToolAvailable)
    throw new T3ProviderPreconditionError(
      "provider-question-tool-unavailable",
      `Cannot dispatch 'thread.turn.start': provider '${context.driver}' CLI version '${context.cliVersion}' has no question tool for assistive sessions`,
    );
};
