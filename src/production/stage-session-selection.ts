// ---
// relationships:
//   implements: heddle
// ---

import {
  ProviderSelectionError,
  type ProviderSelectionInputs,
  type ProviderSelectionReason,
  type ResolvedProviderSelection,
} from "../control-plane/index.js";
import type { ResolvedSessionRuntimeMode } from "../persistence/index.js";
import {
  taskProviderAliasForStage,
  type TaskProviderAliasMap,
} from "../provider-alias.js";
import type { ResolvedProductionSessionConfiguration } from "./configuration.js";

export interface StageProviderSelectionResolver {
  resolve(
    alias: string,
    inputs: ProviderSelectionInputs,
  ): Promise<ResolvedProviderSelection>;
}

export class StageSessionSelectionError extends Error {
  public readonly reason?: ProviderSelectionReason;

  public constructor(
    readonly taskId: number,
    readonly stageId: string,
    cause: unknown,
  ) {
    super(
      `Task ${taskId} stage '${stageId}' cannot select a session: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "StageSessionSelectionError";
    this.reason =
      cause instanceof ProviderSelectionError ? cause.reason : undefined;
  }
}

export const resolveStageSessionSelection = async (
  input: {
    session: ResolvedProductionSessionConfiguration;
    stageId: string;
    stageProviderAlias?: string;
    stageRuntimeMode?: ResolvedSessionRuntimeMode;
    taskId: number;
    taskProviderAliases?: TaskProviderAliasMap;
  },
  resolver: StageProviderSelectionResolver,
): Promise<ResolvedProviderSelection> => {
  const alias =
    taskProviderAliasForStage(input.taskProviderAliases, input.stageId) ??
    input.stageProviderAlias ??
    input.session.defaultProviderAlias;
  try {
    return await resolver.resolve(alias, {
      interactionMode: input.session.interactionMode,
      runtimeMode: input.stageRuntimeMode ?? input.session.defaultRuntimeMode,
    });
  } catch (error) {
    throw new StageSessionSelectionError(input.taskId, input.stageId, error);
  }
};

export class StartupProviderSelectionResolver implements StageProviderSelectionResolver {
  public constructor(
    private readonly selections: readonly ResolvedProviderSelection[],
  ) {}

  public async resolve(
    alias: string,
    inputs: ProviderSelectionInputs,
  ): Promise<ResolvedProviderSelection> {
    const selection = this.selections.find(
      (candidate) => candidate.alias === alias,
    );
    if (selection === undefined) {
      throw new ProviderSelectionError(
        "provider-alias-not-allowed",
        `Provider alias '${alias}' cannot be selected: the alias is not configured`,
      );
    }
    return { ...selection, ...inputs };
  }
}
