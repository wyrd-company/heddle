// ---
// relationships:
//   implements: heddle
// ---

import {
  ProviderSelectionError,
  type ProviderSelectionInputs,
  type ProviderSelectionReason,
  type ResolvedProviderCandidateSelection,
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
  resolveCandidates?(
    alias: string,
    inputs: ProviderSelectionInputs,
  ): Promise<readonly ResolvedProviderCandidateSelection[]>;
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

const aliasForStage = (input: {
  session: ResolvedProductionSessionConfiguration;
  stageId: string;
  stageProviderAlias?: string;
  taskProviderAliases?: TaskProviderAliasMap;
}): string =>
  taskProviderAliasForStage(input.taskProviderAliases, input.stageId) ??
  input.stageProviderAlias ??
  input.session.defaultProviderAlias;

export const resolveStageSessionCandidates = async (
  input: {
    session: ResolvedProductionSessionConfiguration;
    stageId: string;
    stageProviderAlias?: string;
    stageRuntimeMode?: ResolvedSessionRuntimeMode;
    taskId: number;
    taskProviderAliases?: TaskProviderAliasMap;
  },
  resolver: StageProviderSelectionResolver,
): Promise<readonly ResolvedProviderCandidateSelection[]> => {
  const alias = aliasForStage(input);
  const inputs = {
    interactionMode: input.session.interactionMode,
    runtimeMode: input.stageRuntimeMode ?? input.session.defaultRuntimeMode,
  };
  try {
    return resolver.resolveCandidates === undefined
      ? [
          {
            ...(await resolver.resolve(alias, inputs)),
            candidatePosition: 1,
            catalogFailures: [],
            skippedCandidates: [],
          },
        ]
      : await resolver.resolveCandidates(alias, inputs);
  } catch (error) {
    throw new StageSessionSelectionError(input.taskId, input.stageId, error);
  }
};

export const resolveStageSessionSelection = async (
  input: Parameters<typeof resolveStageSessionCandidates>[0],
  resolver: StageProviderSelectionResolver,
): Promise<ResolvedProviderCandidateSelection> =>
  (await resolveStageSessionCandidates(input, resolver))[0]!;

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

  public async resolveCandidates(
    alias: string,
    inputs: ProviderSelectionInputs,
  ): Promise<readonly ResolvedProviderCandidateSelection[]> {
    const selections = this.selections.filter(
      (candidate) => candidate.alias === alias,
    );
    if (selections.length === 0) {
      return [
        {
          ...(await this.resolve(alias, inputs)),
          candidatePosition: 1,
          catalogFailures: [],
          skippedCandidates: [],
        },
      ];
    }
    return selections.map((selection, index) => {
      const candidate =
        selection as Partial<ResolvedProviderCandidateSelection>;
      return {
        ...selection,
        ...inputs,
        candidatePosition: candidate.candidatePosition ?? index + 1,
        catalogFailures: candidate.catalogFailures ?? [],
        skippedCandidates: candidate.skippedCandidates ?? [],
      };
    });
  }
}
