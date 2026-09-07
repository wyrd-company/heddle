// ---
// relationships:
//   implements: heddle
// ---

import type { ProviderUsageBudget } from "../pacing/index.js";
import {
  RESOLVED_SESSION_RUNTIME_MODES,
  type ResolvedSessionRuntimeMode,
} from "../persistence/types.js";

export type ProviderAliasConfiguration = {
  readonly model: string;
  readonly providerDisplayName: string;
};

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

export type ResolvedProviderStartup = {
  readonly aliases: ReadonlyMap<string, ResolvedProviderSelection>;
  readonly defaultSelection: ResolvedProviderSelection;
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
  readonly #aliases: ReadonlyMap<string, ProviderAliasConfiguration>;
  readonly #catalog: T3ProviderCatalogReader;

  public constructor(
    aliases: ProviderAliasCatalog,
    catalog: T3ProviderCatalogReader,
  ) {
    this.#aliases = new Map(
      Object.entries(aliases).map(([alias, configuration]) => [
        alias,
        { ...configuration },
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

  public async listAllowed(
    inputs: ProviderSelectionInputs,
    startupSelections: readonly ResolvedProviderSelection[],
  ): Promise<ProviderAliasListing> {
    const catalog = await this.readCatalog();
    const startupByAlias = new Map(
      startupSelections.map((selection) => [selection.alias, selection]),
    );
    const aliases = [...this.#aliases.keys()].sort().map((alias) => {
      const startup = startupByAlias.get(alias);
      if (startup === undefined) {
        throw new TypeError(
          `Provider alias '${alias}' has no resolved startup selection`,
        );
      }
      try {
        const current = this.resolveFromCatalog(catalog, alias, inputs);
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
        return {
          alias,
          driverKind: startup.driverKind,
          model: { ...startup.model },
          providerDisplayName: startup.providerDisplayName,
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
    const configured = this.#aliases.get(alias);
    if (configured === undefined) {
      throw selectionError(
        "provider-alias-not-allowed",
        alias,
        "the alias is not configured",
      );
    }
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
    for (const alias of [...this.#aliases.keys()].sort()) {
      aliases.set(alias, this.resolveFromCatalog(catalog, alias, inputs));
    }
    const defaultSelection =
      aliases.get(inputs.defaultAlias) ??
      this.resolveFromCatalog(catalog, inputs.defaultAlias, inputs);
    const providerBudgets = new Map<string, ProviderUsageBudget>();
    const budgetAliases = new Map<string, string>();
    for (const [alias, budget] of Object.entries(inputs.providerBudgets)) {
      const selection =
        aliases.get(alias) ?? this.resolveFromCatalog(catalog, alias, inputs);
      const prior = providerBudgets.get(selection.providerInstanceId);
      if (prior !== undefined && prior.usageLimit !== budget.usageLimit) {
        throw new TypeError(
          `Provider aliases '${budgetAliases.get(selection.providerInstanceId)}' and '${alias}' select provider instance '${selection.providerInstanceId}' with conflicting pacing limits`,
        );
      }
      providerBudgets.set(selection.providerInstanceId, { ...budget });
      budgetAliases.set(selection.providerInstanceId, alias);
    }
    return {
      aliases,
      defaultSelection,
      providerBudgets: Object.fromEntries(providerBudgets),
    };
  }
}
