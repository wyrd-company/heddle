// ---
// relationships:
//   implements: heddle
// ---

import { URL } from "node:url";

import {
  ProviderSelectionError,
  T3_RUNTIME_MODES,
  type ProviderAliasCatalog,
  type ProviderSelectionReason,
  type ProviderSelectionResolver,
  type ResolvedProviderSelection,
  type T3RuntimeMode,
} from "../control-plane/provider-selection.js";
import type { PacingConfiguration } from "../pacing/index.js";
import { isProviderAlias } from "../provider-alias.js";

export type ProductionSessionConfiguration = {
  baseRef: string;
  defaultProviderAlias: string;
  defaultRuntimeMode: T3RuntimeMode;
  interactionMode: string;
  skillPointer: string;
  worktreesRoot?: string;
};

export type ResolvedProductionSessionConfiguration =
  ProductionSessionConfiguration & {
    defaultSelection: ResolvedProviderSelection;
    resolvedSelections: readonly ResolvedProviderSelection[];
  };

export type ProductRepositoryConfiguration = {
  name: string;
  repositoryRoot: string;
};

export type ProductConfiguration = {
  epicProject?: { epicId: number; projectId: string };
  name: string;
  repos: ProductRepositoryConfiguration[];
};

export type AdHocProjectConfiguration = {
  name: string;
  projectId: string;
  workspaceRoot: string;
};

export type PushoverConfiguration = {
  apiUrl: string;
  applicationToken: string;
  consoleBaseUrl: string;
  recipientLabel?: string;
  userKey: string;
};

export const incidentSeverityLevels = [
  "low",
  "moderate",
  "high",
  "critical",
] as const;
export type IncidentSeverity = (typeof incidentSeverityLevels)[number];

export type IncidentConfiguration = {
  approvalSeverityThreshold: IncidentSeverity;
  failureThreshold: number;
  githubIssueRepository: string;
  immediateEscalationCodes?: string[];
  retryDelayMilliseconds: number;
  workspaceRoot: string;
};

export type ProductionConfiguration = {
  adHocProject: AdHocProjectConfiguration;
  boardDirectory: string;
  cadenceMilliseconds: number;
  incident: IncidentConfiguration;
  pacing: Omit<PacingConfiguration, "defaultProvider">;
  observationThresholds: {
    endedMilliseconds: number;
    failedMilliseconds: number;
    stalledMilliseconds: number;
  };
  products: ProductConfiguration[];
  providerAliases: ProviderAliasCatalog;
  pushover: PushoverConfiguration;
  session: ProductionSessionConfiguration;
  stageThresholds: Readonly<Record<string, number>>;
  stateDirectory: string;
  stopTimeoutMilliseconds: number;
  t3: { accessToken: string; baseUrl: string };
};

export type ResolvedProductionConfiguration = Omit<
  ProductionConfiguration,
  "pacing" | "session"
> & {
  pacing: PacingConfiguration;
  session: ResolvedProductionSessionConfiguration;
};

const requireAbsolute = (name: string, value: string): void => {
  if (!value.startsWith("/")) throw new TypeError(`${name} must be absolute`);
};

const requireNonEmpty = (name: string, value: string): void => {
  if (value.trim() === "") throw new TypeError(`${name} must not be empty`);
};

const requireHttpUrl = (name: string, value: string): void => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${name} must be an HTTP URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`${name} must be an HTTP URL`);
  }
};

const requirePositiveInteger = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
};

const validateCommonProductionConfiguration = (
  configuration: Omit<ProductionConfiguration, "pacing" | "session"> & {
    pacing: Omit<PacingConfiguration, "defaultProvider">;
    session: ProductionSessionConfiguration;
  },
  validateBudgetAliases = true,
): void => {
  requireNonEmpty("adHocProject.name", configuration.adHocProject.name);
  requireNonEmpty(
    "adHocProject.projectId",
    configuration.adHocProject.projectId,
  );
  requireAbsolute(
    "adHocProject.workspaceRoot",
    configuration.adHocProject.workspaceRoot,
  );
  requireAbsolute("boardDirectory", configuration.boardDirectory);
  requireAbsolute("stateDirectory", configuration.stateDirectory);
  requirePositiveInteger(
    "cadenceMilliseconds",
    configuration.cadenceMilliseconds,
  );
  requireAbsolute(
    "incident.workspaceRoot",
    configuration.incident.workspaceRoot,
  );
  requirePositiveInteger(
    "incident.failureThreshold",
    configuration.incident.failureThreshold,
  );
  requirePositiveInteger(
    "incident.retryDelayMilliseconds",
    configuration.incident.retryDelayMilliseconds,
  );
  if (
    !incidentSeverityLevels.includes(
      configuration.incident.approvalSeverityThreshold,
    )
  ) {
    throw new TypeError(
      `incident.approvalSeverityThreshold must be one of '${incidentSeverityLevels.join("', '")}'`,
    );
  }
  if (
    !/^[^/\s]+\/[^/\s]+$/.test(configuration.incident.githubIssueRepository)
  ) {
    throw new TypeError(
      "incident.githubIssueRepository must be an owner/name repository",
    );
  }
  for (const code of configuration.incident.immediateEscalationCodes ?? []) {
    requireNonEmpty("incident.immediateEscalationCodes", code);
  }
  requirePositiveInteger(
    "stopTimeoutMilliseconds",
    configuration.stopTimeoutMilliseconds,
  );
  if (configuration.products.length === 0) {
    throw new TypeError("products must not be empty");
  }
  const productNames = new Set<string>();
  const repositoryNames = new Set<string>();
  const projectIds = new Set<string>([configuration.adHocProject.projectId]);
  const epicIds = new Set<number>();
  for (const product of configuration.products) {
    requireNonEmpty("products.name", product.name);
    if (productNames.has(product.name)) {
      throw new TypeError(`products repeats product '${product.name}'`);
    }
    productNames.add(product.name);
    if (product.repos.length === 0) {
      throw new TypeError(`products.${product.name}.repos must not be empty`);
    }
    for (const repository of product.repos) {
      requireNonEmpty("products.repos.name", repository.name);
      requireAbsolute(
        `products.${product.name}.repos.${repository.name}.repositoryRoot`,
        repository.repositoryRoot,
      );
      if (repositoryNames.has(repository.name)) {
        throw new TypeError(
          `repository '${repository.name}' must belong to exactly one product`,
        );
      }
      repositoryNames.add(repository.name);
    }
    if (product.epicProject !== undefined) {
      requirePositiveInteger(
        `products.${product.name}.epicProject.epicId`,
        product.epicProject.epicId,
      );
      requireNonEmpty(
        `products.${product.name}.epicProject.projectId`,
        product.epicProject.projectId,
      );
      if (epicIds.has(product.epicProject.epicId)) {
        throw new TypeError(
          `epic ${product.epicProject.epicId} has more than one configured project`,
        );
      }
      if (projectIds.has(product.epicProject.projectId)) {
        throw new TypeError(
          `projectId '${product.epicProject.projectId}' must be globally unique`,
        );
      }
      epicIds.add(product.epicProject.epicId);
      projectIds.add(product.epicProject.projectId);
    }
  }
  requireHttpUrl("t3.baseUrl", configuration.t3.baseUrl);
  requireNonEmpty("t3.accessToken", configuration.t3.accessToken);
  for (const [stage, threshold] of Object.entries(
    configuration.stageThresholds,
  )) {
    requireNonEmpty("stageThreshold", stage);
    requirePositiveInteger(`stageThresholds.${stage}`, threshold);
  }
  for (const [kind, threshold] of Object.entries(
    configuration.observationThresholds,
  )) {
    requirePositiveInteger(`observationThresholds.${kind}`, threshold);
  }
  requireNonEmpty("session.baseRef", configuration.session.baseRef);
  requireNonEmpty(
    "session.defaultProviderAlias",
    configuration.session.defaultProviderAlias,
  );
  requireNonEmpty(
    "session.interactionMode",
    configuration.session.interactionMode,
  );
  requireNonEmpty("session.skillPointer", configuration.session.skillPointer);
  if (configuration.session.worktreesRoot !== undefined) {
    requireNonEmpty(
      "session.worktreesRoot",
      configuration.session.worktreesRoot,
    );
    requireAbsolute(
      "session.worktreesRoot",
      configuration.session.worktreesRoot,
    );
  }
  if (!T3_RUNTIME_MODES.includes(configuration.session.defaultRuntimeMode)) {
    throw new TypeError(
      `session.defaultRuntimeMode must be one of '${T3_RUNTIME_MODES.join("', '")}'`,
    );
  }
  const aliases = Object.entries(configuration.providerAliases);
  if (aliases.length === 0) {
    throw new TypeError("providerAliases must not be empty");
  }
  for (const [alias, provider] of aliases) {
    if (!isProviderAlias(alias)) {
      throw new TypeError(
        `providerAliases key '${alias}' must be a lower-kebab alias of at most 64 characters`,
      );
    }
    const candidates = Array.isArray(provider) ? provider : [provider];
    if (candidates.length === 0) {
      throw new TypeError(`providerAliases.${alias} must not be empty`);
    }
    candidates.forEach((candidate, index) => {
      const path = Array.isArray(provider)
        ? `providerAliases.${alias}[${index}]`
        : `providerAliases.${alias}`;
      requireNonEmpty(
        `${path}.providerDisplayName`,
        candidate.providerDisplayName,
      );
      requireNonEmpty(`${path}.model`, candidate.model);
    });
  }
  if (
    !Object.hasOwn(
      configuration.providerAliases,
      configuration.session.defaultProviderAlias,
    )
  ) {
    throw new TypeError(
      `session.defaultProviderAlias '${configuration.session.defaultProviderAlias}' is not configured in providerAliases`,
    );
  }
  if (validateBudgetAliases) {
    for (const alias of Object.keys(configuration.pacing.providerBudgets)) {
      if (!Object.hasOwn(configuration.providerAliases, alias)) {
        throw new TypeError(
          `pacing.providerBudgets alias '${alias}' is not configured in providerAliases`,
        );
      }
    }
  }
  requireHttpUrl("pushover.apiUrl", configuration.pushover.apiUrl);
  requireNonEmpty(
    "pushover.applicationToken",
    configuration.pushover.applicationToken,
  );
  requireHttpUrl(
    "pushover.consoleBaseUrl",
    configuration.pushover.consoleBaseUrl,
  );
  if (configuration.pushover.recipientLabel !== undefined) {
    requireNonEmpty(
      "pushover.recipientLabel",
      configuration.pushover.recipientLabel,
    );
    for (const secret of [
      configuration.pushover.applicationToken,
      configuration.pushover.userKey,
    ]) {
      if (
        secret !== "" &&
        configuration.pushover.recipientLabel.includes(secret)
      ) {
        throw new TypeError(
          "pushover.recipientLabel must not contain a Pushover credential",
        );
      }
    }
  }
  requireNonEmpty("pushover.userKey", configuration.pushover.userKey);
};

export const validateProductionConfiguration = (
  configuration: ProductionConfiguration,
): ProductionConfiguration => {
  validateCommonProductionConfiguration(configuration);
  return configuration;
};

export const validateResolvedProductionConfiguration = (
  configuration: ResolvedProductionConfiguration,
): ResolvedProductionConfiguration => {
  const { defaultSelection, resolvedSelections, ...session } =
    configuration.session;
  const { defaultProvider: _defaultProvider, ...pacing } = configuration.pacing;
  void _defaultProvider;
  validateCommonProductionConfiguration(
    { ...configuration, pacing, session },
    false,
  );
  if (
    defaultSelection.alias !== session.defaultProviderAlias ||
    defaultSelection.interactionMode !== session.interactionMode ||
    defaultSelection.runtimeMode !== session.defaultRuntimeMode ||
    defaultSelection.providerInstanceId !== configuration.pacing.defaultProvider
  ) {
    throw new TypeError(
      "session.defaultSelection must match the configured default alias, runtime, interaction, and pacing provider",
    );
  }
  const resolvedDefault = resolvedSelections.find(
    ({ alias }) => alias === session.defaultProviderAlias,
  );
  if (
    resolvedDefault === undefined ||
    resolvedDefault.driverKind !== defaultSelection.driverKind ||
    resolvedDefault.interactionMode !== defaultSelection.interactionMode ||
    resolvedDefault.model.slug !== defaultSelection.model.slug ||
    resolvedDefault.observedCliVersion !==
      defaultSelection.observedCliVersion ||
    resolvedDefault.providerInstanceId !==
      defaultSelection.providerInstanceId ||
    resolvedDefault.runtimeMode !== defaultSelection.runtimeMode
  ) {
    throw new TypeError(
      "session.defaultSelection must be the default alias entry in session.resolvedSelections",
    );
  }
  return configuration;
};

/**
 * T3 discovers whether each configured provider's harness is installed after
 * it starts serving, reporting `state: warning` until that completes. A
 * service that starts alongside T3 therefore resolves its aliases at the one
 * moment the answer is guaranteed to be wrong, and reports a provider that is
 * merely not discovered yet as permanently unavailable.
 *
 * Only these two reasons are transient at boot. Every other selection failure
 * is a configuration error that waiting cannot repair.
 */
const STARTUP_TRANSIENT_REASONS: ReadonlySet<ProviderSelectionReason> = new Set(
  ["provider-catalog-unavailable", "provider-not-ready"],
);

export type StartupReadinessOptions = {
  readonly pollMilliseconds?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly timeoutMilliseconds?: number;
};

const DEFAULT_STARTUP_READINESS_TIMEOUT_MILLISECONDS = 60_000;
const DEFAULT_STARTUP_READINESS_POLL_MILLISECONDS = 500;

export const resolveProductionConfiguration = async (
  configuration: ProductionConfiguration,
  resolver: ProviderSelectionResolver,
  readiness: StartupReadinessOptions = {},
): Promise<ResolvedProductionConfiguration> => {
  const validated = validateProductionConfiguration(configuration);
  const timeoutMilliseconds =
    readiness.timeoutMilliseconds ??
    DEFAULT_STARTUP_READINESS_TIMEOUT_MILLISECONDS;
  const pollMilliseconds =
    readiness.pollMilliseconds ?? DEFAULT_STARTUP_READINESS_POLL_MILLISECONDS;
  const now = readiness.now ?? (() => Date.now());
  const sleep =
    readiness.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, milliseconds);
      }));
  const startupInputs = {
    defaultAlias: validated.session.defaultProviderAlias,
    interactionMode: validated.session.interactionMode,
    providerBudgets: validated.pacing.providerBudgets,
    runtimeMode: validated.session.defaultRuntimeMode,
  };
  const deadline = now() + timeoutMilliseconds;
  const resolveStartupWhenReady = async (): Promise<
    Awaited<ReturnType<ProviderSelectionResolver["resolveStartup"]>>
  > => {
    for (;;) {
      try {
        return await resolver.resolveStartup(startupInputs);
      } catch (error) {
        if (
          !(error instanceof ProviderSelectionError) ||
          !STARTUP_TRANSIENT_REASONS.has(error.reason) ||
          now() >= deadline
        ) {
          throw error;
        }
        await sleep(pollMilliseconds);
      }
    }
  };
  const startup = await resolveStartupWhenReady();
  const resolved: ResolvedProductionConfiguration = {
    ...validated,
    pacing: {
      ...validated.pacing,
      defaultProvider: startup.defaultSelection.providerInstanceId,
      providerBudgets: startup.providerBudgets,
    },
    session: {
      ...validated.session,
      defaultSelection: startup.defaultSelection,
      resolvedSelections: [...startup.candidates.values()].flat(),
    },
  };
  return validateResolvedProductionConfiguration(resolved);
};
