// ---
// relationships:
//   implements: heddle
// ---

import type { ProviderUsageBudget } from "../pacing/index.js";
import { errorDetail } from "../error-details.js";
import {
  RESOLVED_SESSION_RUNTIME_MODES,
  type SkippedProviderCandidate,
  type ResolvedSessionRuntimeMode,
} from "../persistence/types.js";

export type ProviderAliasCandidateConfiguration = {
  readonly model: string;
  readonly providerDisplayName: string;
};

export type ProviderAliasConfiguration =
  | ProviderAliasCandidateConfiguration
  | readonly ProviderAliasCandidateConfiguration[];

export type ProviderAliasCatalog = Readonly<
  Record<string, ProviderAliasConfiguration>
>;

export type T3ProviderCatalogModel = {
  readonly isCustom: boolean;
  readonly name: string;
  readonly slug: string;
};

export type T3ProviderCatalogEntry = {
  readonly availability: "available" | "unavailable";
  readonly displayName?: string;
  readonly driverKind: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly instanceId: string;
  readonly models: readonly T3ProviderCatalogModel[];
  readonly observedCliVersion: string | null;
  readonly state: string;
};

export type T3ProviderCatalog = readonly T3ProviderCatalogEntry[];

export interface T3ProviderCatalogReader {
  readProviderCatalog(): Promise<T3ProviderCatalog>;
}

export type ProviderSelectionReason =
  | "provider-catalog-unavailable"
  | "provider-alias-not-allowed"
  | "provider-name-not-found"
  | "provider-name-ambiguous"
  | "provider-not-ready"
  | "provider-unavailable"
  | "provider-model-not-found";

export const T3_RUNTIME_MODES = RESOLVED_SESSION_RUNTIME_MODES;

export type T3RuntimeMode = ResolvedSessionRuntimeMode;

export class ProviderSelectionError extends Error {
  public constructor(
    readonly reason: ProviderSelectionReason,
    message: string,
  ) {
    super(message);
    this.name = "ProviderSelectionError";
  }
}

export class ProviderAliasUnusableError extends ProviderSelectionError {
  public constructor(
    reason: ProviderSelectionReason,
    message: string,
    readonly skippedCandidates: readonly SkippedProviderCandidate[],
  ) {
    super(reason, message);
    this.name = "ProviderAliasUnusableError";
  }
}

export type ProviderSelectionInputs = {
  readonly interactionMode: string;
  readonly runtimeMode: T3RuntimeMode;
};

export type ResolvedProviderSelection = {
  readonly alias: string;
  readonly driverKind: string;
  readonly interactionMode: string;
  readonly model: T3ProviderCatalogModel;
  readonly observedCliVersion: string | null;
  readonly providerDisplayName: string;
  readonly providerInstanceId: string;
  readonly runtimeMode: T3RuntimeMode;
};

export type ResolvedProviderCandidateSelection = ResolvedProviderSelection & {
  readonly candidatePosition: number;
  readonly catalogFailures: readonly SkippedProviderCandidate[];
  readonly skippedCandidates: readonly SkippedProviderCandidate[];
};

export type ResolvedProviderStartup = {
  readonly aliases: ReadonlyMap<string, ResolvedProviderSelection>;
  readonly candidates: ReadonlyMap<
    string,
    readonly ResolvedProviderCandidateSelection[]
  >;
  readonly defaultSelection: ResolvedProviderSelection;
  readonly providerAliasBudgets: Readonly<Record<string, ProviderUsageBudget>>;
  readonly providerBudgets: Readonly<Record<string, ProviderUsageBudget>>;
};

export type ProviderAliasAvailabilityReason = Exclude<
  ProviderSelectionReason,
  "provider-alias-not-allowed" | "provider-catalog-unavailable"
>;

export type ProviderAliasAvailability = {
  readonly alias: string;
  readonly driverKind: string;
  readonly model: T3ProviderCatalogModel;
  readonly providerDisplayName: string;
  readonly reason: ProviderAliasAvailabilityReason | null;
  readonly selectable: boolean;
};

export type ProviderAliasListing = {
  readonly aliases: readonly ProviderAliasAvailability[];
  readonly runtimeModes: readonly T3RuntimeMode[];
  readonly version: 1;
};

export type ProviderStartupInputs = ProviderSelectionInputs & {
  readonly defaultAlias: string;
  readonly providerBudgets: Readonly<Record<string, ProviderUsageBudget>>;
};

const providerSelectionOnly = (
  candidate: ResolvedProviderCandidateSelection,
): ResolvedProviderSelection => {
  const {
    candidatePosition: _candidatePosition,
    catalogFailures: _catalogFailures,
    skippedCandidates: _skippedCandidates,
    ...selection
  } = candidate;
  void _candidatePosition;
  void _catalogFailures;
  void _skippedCandidates;
  return selection;
};

const selectionError = (
  reason: Exclude<ProviderSelectionReason, "provider-catalog-unavailable">,
  alias: string,
  detail: string,
): ProviderSelectionError =>
  new ProviderSelectionError(
    reason,
    `Provider alias '${alias}' cannot be selected: ${detail}`,
  );

export class ProviderSelectionResolver {
  readonly #aliases: ReadonlyMap<
    string,
    readonly ProviderAliasCandidateConfiguration[]
  >;
  readonly #catalog: T3ProviderCatalogReader;

  public constructor(
    aliases: ProviderAliasCatalog,
    catalog: T3ProviderCatalogReader,
  ) {
    this.#aliases = new Map(
      Object.entries(aliases).map(([alias, configuration]) => [
        alias,
        (Array.isArray(configuration) ? configuration : [configuration]).map(
          (candidate) => ({ ...candidate }),
        ),
      ]),
    );
    this.#catalog = catalog;
  }

  public async readCatalog(): Promise<T3ProviderCatalog> {
    try {
      return await this.#catalog.readProviderCatalog();
    } catch {
      throw new ProviderSelectionError(
        "provider-catalog-unavailable",
        "T3 provider catalog is unavailable",
      );
    }
  }

  public async resolve(
    alias: string,
    inputs: ProviderSelectionInputs,
  ): Promise<ResolvedProviderSelection> {
    return this.resolveFromCatalog(await this.readCatalog(), alias, inputs);
  }

  public async resolveCandidates(
    alias: string,
    inputs: ProviderSelectionInputs,
  ): Promise<readonly ResolvedProviderCandidateSelection[]> {
    return this.resolveCandidatesFromCatalog(
      await this.readCatalog(),
      alias,
      inputs,
    );
  }

  public async listAllowed(
    inputs: ProviderSelectionInputs,
    startupSelections: readonly ResolvedProviderSelection[],
  ): Promise<ProviderAliasListing> {
    const catalog = await this.readCatalog();
    const startupByAlias = new Map<string, ResolvedProviderSelection>();
    for (const selection of startupSelections) {
      if (!startupByAlias.has(selection.alias)) {
        startupByAlias.set(selection.alias, selection);
      }
    }
    const aliases = [...this.#aliases.keys()].sort().map((alias) => {
      const startup = startupByAlias.get(alias);
      if (startup === undefined) {
        throw new TypeError(
          `Provider alias '${alias}' has no resolved startup selection`,
        );
      }
      const configured = this.#aliases.get(alias)![0]!;
      try {
        const current = this.#resolveCandidateFromCatalog(
          catalog,
          alias,
          configured,
          inputs,
        );
        return {
          alias,
          driverKind: current.driverKind,
          model: { ...current.model },
          providerDisplayName: current.providerDisplayName,
          reason: null,
          selectable: true,
        } satisfies ProviderAliasAvailability;
      } catch (error) {
        if (
          !(error instanceof ProviderSelectionError) ||
          error.reason === "provider-alias-not-allowed" ||
          error.reason === "provider-catalog-unavailable"
        ) {
          throw error;
        }
        const providers = catalog.filter(
          ({ displayName }) => displayName === configured.providerDisplayName,
        );
        const provider = providers.length === 1 ? providers[0] : undefined;
        const model = provider?.models.find(
          ({ slug }) => slug === configured.model,
        );
        const startupMatchesConfigured =
          startup.providerDisplayName === configured.providerDisplayName &&
          startup.model.slug === configured.model;
        return {
          alias,
          driverKind:
            provider?.driverKind ??
            (startupMatchesConfigured ? startup.driverKind : "unknown"),
          model:
            model === undefined
              ? startupMatchesConfigured
                ? { ...startup.model }
                : {
                    isCustom: false,
                    name: configured.model,
                    slug: configured.model,
                  }
              : { ...model },
          providerDisplayName: configured.providerDisplayName,
          reason: error.reason,
          selectable: false,
        } satisfies ProviderAliasAvailability;
      }
    });
    return {
      aliases,
      runtimeModes: [...T3_RUNTIME_MODES],
      version: 1,
    };
  }

  public resolveFromCatalog(
    catalog: T3ProviderCatalog,
    alias: string,
    inputs: ProviderSelectionInputs,
  ): ResolvedProviderSelection {
    return providerSelectionOnly(
      this.resolveCandidatesFromCatalog(catalog, alias, inputs)[0]!,
    );
  }

  public resolveCandidatesFromCatalog(
    catalog: T3ProviderCatalog,
    alias: string,
    inputs: ProviderSelectionInputs,
  ): readonly ResolvedProviderCandidateSelection[] {
    const configuredCandidates = this.#aliases.get(alias);
    if (configuredCandidates === undefined) {
      throw selectionError(
        "provider-alias-not-allowed",
        alias,
        "the alias is not configured",
      );
    }
    const resolved: ResolvedProviderCandidateSelection[] = [];
    const skipped: SkippedProviderCandidate[] = [];
    const failures: ProviderSelectionError[] = [];
    configuredCandidates.forEach((configured, index) => {
      const candidatePosition = index + 1;
      let selection: ResolvedProviderSelection;
      try {
        selection = this.#resolveCandidateFromCatalog(
          catalog,
          alias,
          configured,
          inputs,
        );
      } catch (error) {
        if (!(error instanceof ProviderSelectionError)) throw error;
        failures.push(error);
        skipped.push({
          candidatePosition,
          failure: errorDetail(error),
          modelSlug: configured.model,
          providerDisplayName: configured.providerDisplayName,
        });
        return;
      }
      resolved.push({
        ...selection,
        candidatePosition,
        catalogFailures: [],
        skippedCandidates: skipped.map((candidate) => ({
          ...candidate,
          failure: { ...candidate.failure },
        })),
      });
    });
    if (resolved.length > 0) {
      return resolved.map((selection) => ({
        ...selection,
        catalogFailures: skipped.map((candidate) => ({
          ...candidate,
          failure: { ...candidate.failure },
        })),
      }));
    }
    const reportedFailure =
      failures.find(({ reason }) => reason === "provider-not-ready") ??
      failures[0]!;
    throw new ProviderAliasUnusableError(
      reportedFailure.reason,
      `Provider alias '${alias}' cannot be selected because every candidate is unusable: ${skipped
        .map(
          ({ candidatePosition, failure, modelSlug, providerDisplayName }) =>
            `candidate ${candidatePosition} '${providerDisplayName}' model '${modelSlug}': ${failure.message}`,
        )
        .join("; ")}`,
      skipped,
    );
  }

  #resolveCandidateFromCatalog(
    catalog: T3ProviderCatalog,
    alias: string,
    configured: ProviderAliasCandidateConfiguration,
    inputs: ProviderSelectionInputs,
  ): ResolvedProviderSelection {
    const providers = catalog.filter(
      ({ displayName }) => displayName === configured.providerDisplayName,
    );
    if (providers.length === 0) {
      throw selectionError(
        "provider-name-not-found",
        alias,
        `T3 has no provider named '${configured.providerDisplayName}'`,
      );
    }
    if (providers.length > 1) {
      throw selectionError(
        "provider-name-ambiguous",
        alias,
        `T3 has more than one provider named '${configured.providerDisplayName}'`,
      );
    }
    const provider = providers[0]!;
    if (provider.enabled && provider.state === "warning") {
      throw selectionError(
        "provider-not-ready",
        alias,
        `T3 provider '${configured.providerDisplayName}' has not finished discovery`,
      );
    }
    if (
      provider.availability !== "available" ||
      !provider.enabled ||
      !provider.installed ||
      provider.state !== "ready"
    ) {
      throw selectionError(
        "provider-unavailable",
        alias,
        `T3 provider '${configured.providerDisplayName}' is not available, enabled, installed, and ready`,
      );
    }
    const model = provider.models.find(({ slug }) => slug === configured.model);
    if (model === undefined) {
      throw selectionError(
        "provider-model-not-found",
        alias,
        `T3 provider '${configured.providerDisplayName}' has no model slug '${configured.model}'`,
      );
    }
    return {
      alias,
      driverKind: provider.driverKind,
      interactionMode: inputs.interactionMode,
      model: { ...model },
      observedCliVersion: provider.observedCliVersion,
      providerDisplayName: configured.providerDisplayName,
      providerInstanceId: provider.instanceId,
      runtimeMode: inputs.runtimeMode,
    };
  }

  public async resolveStartup(
    inputs: ProviderStartupInputs,
  ): Promise<ResolvedProviderStartup> {
    const catalog = await this.readCatalog();
    const aliases = new Map<string, ResolvedProviderSelection>();
    const candidates = new Map<
      string,
      readonly ResolvedProviderCandidateSelection[]
    >();
    for (const alias of [...this.#aliases.keys()].sort()) {
      const resolved = this.resolveCandidatesFromCatalog(
        catalog,
        alias,
        inputs,
      );
      candidates.set(alias, resolved);
      aliases.set(alias, providerSelectionOnly(resolved[0]!));
    }
    const defaultSelection =
      aliases.get(inputs.defaultAlias) ??
      this.resolveFromCatalog(catalog, inputs.defaultAlias, inputs);
    const providerBudgets = new Map<string, ProviderUsageBudget>();
    const budgetAliases = new Map<string, string>();
    for (const [alias, budget] of Object.entries(inputs.providerBudgets)) {
      const selections =
        candidates.get(alias) ??
        this.resolveCandidatesFromCatalog(catalog, alias, inputs);
      const configuredCandidates = this.#aliases.get(alias);
      if (configuredCandidates === undefined) {
        this.resolveCandidatesFromCatalog(catalog, alias, inputs);
        throw new Error("unreachable");
      }
      const candidateProviderInstanceIds = new Set([
        ...selections.map(({ providerInstanceId }) => providerInstanceId),
        ...configuredCandidates.flatMap(({ providerDisplayName }) =>
          catalog
            .filter(({ displayName }) => displayName === providerDisplayName)
            .map(({ instanceId }) => instanceId),
        ),
      ]);
      for (const providerInstanceId of candidateProviderInstanceIds) {
        const prior = providerBudgets.get(providerInstanceId);
        if (prior !== undefined && prior.usageLimit !== budget.usageLimit) {
          throw new TypeError(
            `Provider aliases '${budgetAliases.get(providerInstanceId)}' and '${alias}' select provider instance '${providerInstanceId}' with conflicting pacing limits`,
          );
        }
        providerBudgets.set(providerInstanceId, { ...budget });
        budgetAliases.set(providerInstanceId, alias);
      }
    }
    return {
      aliases,
      candidates,
      defaultSelection,
      providerAliasBudgets: Object.fromEntries(
        Object.entries(inputs.providerBudgets).map(([alias, budget]) => [
          alias,
          { ...budget },
        ]),
      ),
      providerBudgets: Object.fromEntries(providerBudgets),
    };
  }
}
