// ---
// relationships:
//   implements: heddle
// ---

import { errorDetail } from "../error-details.js";
import {
  assertModelOffersReasoningEffort,
  ProviderAliasUnusableError,
  ProviderSelectionError,
  type ProviderSelectionInputs,
  type ProviderSelectionReason,
  type ResolvedProviderCandidateSelection,
  ReasoningEffortUnsupportedError,
  type ResolvedProviderSelection,
} from "../control-plane/index.js";
import type {
  ResolvedSessionRuntimeMode,
  SkippedProviderCandidate,
} from "../persistence/index.js";
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
      cause instanceof ProviderSelectionError
        ? cause.reason
        : cause instanceof ReasoningEffortUnsupportedError
          ? "provider-reasoning-effort-unsupported"
          : undefined;
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
    stageReasoningEffort?: string;
    /** Which blueprint layer set `stageReasoningEffort`, named in a refusal. */
    stageReasoningEffortOrigin?: string;
    stageRuntimeMode?: ResolvedSessionRuntimeMode;
    taskId: number;
    taskProviderAliases?: TaskProviderAliasMap;
  },
  resolver: StageProviderSelectionResolver,
): Promise<readonly ResolvedProviderCandidateSelection[]> => {
  const alias = aliasForStage(input);
  // The blueprint layers travel with the selection inputs so the resolver
  // applies them per candidate: a model that does not offer the value makes
  // that candidate unusable, not the stage.
  const inputs = {
    interactionMode: input.session.interactionMode,
    ...(input.stageReasoningEffort === undefined
      ? {}
      : {
          reasoningEffortOverride: {
            origin:
              input.stageReasoningEffortOrigin ?? `Stage '${input.stageId}'`,
            value: input.stageReasoningEffort,
          },
        }),
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
    return (await this.resolveCandidates(alias, inputs))[0]!;
  }

  public async resolveCandidates(
    alias: string,
    inputs: ProviderSelectionInputs,
  ): Promise<readonly ResolvedProviderCandidateSelection[]> {
    const { reasoningEffortOverride, ...selectionInputs } = inputs;
    const selections = this.selections.filter(
      (candidate) => candidate.alias === alias,
    );
    if (selections.length === 0) {
      throw new ProviderSelectionError(
        "provider-alias-not-allowed",
        `Provider alias '${alias}' cannot be selected: the alias is not configured`,
      );
    }
    const resolved: ResolvedProviderCandidateSelection[] = [];
    const skipped: SkippedProviderCandidate[] = [];
    let failure: ProviderSelectionError | undefined;
    selections.forEach((selection, index) => {
      const candidate =
        selection as Partial<ResolvedProviderCandidateSelection>;
      const candidatePosition = candidate.candidatePosition ?? index + 1;
      let effort: Pick<
        ResolvedProviderSelection,
        "reasoningEffort" | "reasoningEffortOptionId"
      > = {};
      if (reasoningEffortOverride !== undefined) {
        try {
          // A candidate whose model does not offer the value is unusable, so
          // it is skipped and recorded, never the whole selection.
          effort = {
            reasoningEffort: reasoningEffortOverride.value,
            reasoningEffortOptionId: assertModelOffersReasoningEffort({
              modelSlug: selection.model.slug,
              optionDescriptors: selection.model.optionDescriptors,
              origin: reasoningEffortOverride.origin,
              reasoningEffort: reasoningEffortOverride.value,
            }).optionId,
          };
        } catch (error) {
          if (!(error instanceof ReasoningEffortUnsupportedError)) throw error;
          failure ??= new ProviderSelectionError(
            "provider-reasoning-effort-unsupported",
            `Provider alias '${alias}' cannot be selected: ${error.message}`,
          );
          skipped.push({
            candidatePosition,
            failure: errorDetail(error),
            modelSlug: selection.model.slug,
            providerDisplayName: selection.providerDisplayName,
          });
          return;
        }
      }
      resolved.push({
        ...selection,
        ...selectionInputs,
        ...effort,
        candidatePosition,
        catalogFailures: candidate.catalogFailures ?? [],
        skippedCandidates: [
          ...(candidate.skippedCandidates ?? []),
          ...skipped.map((entry) => ({
            ...entry,
            failure: { ...entry.failure },
          })),
        ],
      });
    });
    if (resolved.length === 0) {
      throw new ProviderAliasUnusableError(
        failure!.reason,
        failure!.message,
        skipped,
      );
    }
    return resolved.map((selection) => ({
      ...selection,
      catalogFailures: [
        ...selection.catalogFailures,
        ...skipped.map((entry) => ({
          ...entry,
          failure: { ...entry.failure },
        })),
      ],
    }));
  }
}
