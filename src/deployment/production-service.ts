// ---
// relationships:
//   implements: heddle
// ---

import process from "node:process";

import {
  ProviderSelectionResolver,
  T3ControlPlaneClient,
  type T3ProviderCatalogReader,
} from "../control-plane/index.js";
import { describeError } from "../error-details.js";
import type { ProviderUsageSource } from "../pacing/index.js";
import {
  createProductionComposition,
  resolveProductionConfiguration,
  type ProductionComposition,
  type ProductionCompositionOptions,
  type ProductionT3Client,
} from "../production/index.js";
import type { LoadedDeploymentConfiguration } from "./configuration.js";
import {
  ExecutableProviderUsageSource,
  createUnconfiguredProviderUsageSource,
} from "./provider-usage.js";
import { startHeddleServer, type HeddleDeploymentServer } from "./server.js";
import { ConfiguredT3ControlPlaneClient } from "./timeout-application.js";
import { configurationDirectorySystemPromptResolver } from "./system-prompt.js";

export type ConfiguredProductionServiceDependencies = Partial<
  Pick<
    ProductionCompositionOptions,
    | "afterEscalationEffect"
    | "afterPushoverTransportSuccess"
    | "onSchedulerError"
    | "pushoverTransport"
    | "t3"
  >
> & {
  providerCatalog?: T3ProviderCatalogReader;
};

const providerUsageSource = (
  loaded: LoadedDeploymentConfiguration,
): ProviderUsageSource =>
  loaded.providerUsage === undefined
    ? createUnconfiguredProviderUsageSource()
    : new ExecutableProviderUsageSource(loaded.providerUsage);

const t3Client = (loaded: LoadedDeploymentConfiguration): ProductionT3Client =>
  loaded.launchPreparation === undefined
    ? new T3ControlPlaneClient(loaded.configuration.t3)
    : new ConfiguredT3ControlPlaneClient(
        loaded.configuration.t3,
        loaded.launchPreparation,
      );

const configuredCompositionInputs = async (
  loaded: LoadedDeploymentConfiguration,
  dependencies: ConfiguredProductionServiceDependencies,
) => {
  const t3 = dependencies.t3 ?? t3Client(loaded);
  const providerCatalog =
    dependencies.providerCatalog ??
    ("readProviderCatalog" in t3
      ? (t3 as ProductionT3Client & T3ProviderCatalogReader)
      : undefined);
  if (providerCatalog === undefined) {
    throw new Error(
      "Configured production composition requires a T3 provider catalog reader",
    );
  }
  const providerResolver = new ProviderSelectionResolver(
    loaded.configuration.providerAliases,
    providerCatalog,
  );
  const configuration = await resolveProductionConfiguration(
    loaded.configuration,
    providerResolver,
  );
  return { configuration, providerResolver, t3 };
};

const productionOptions = (
  loaded: LoadedDeploymentConfiguration,
  dependencies: ConfiguredProductionServiceDependencies,
  inputs: Awaited<ReturnType<typeof configuredCompositionInputs>>,
): ProductionCompositionOptions => {
  const { providerCatalog: _providerCatalog, ...compositionDependencies } =
    dependencies;
  void _providerCatalog;
  return {
    ...compositionDependencies,
    blueprintsRepositoryRoot: loaded.blueprintsRepositoryRoot,
    configuration: inputs.configuration,
    providerUsage: providerUsageSource(loaded),
    providerResolver: inputs.providerResolver,
    resolveSystemPrompt: configurationDirectorySystemPromptResolver(
      loaded.configurationDirectory,
    ),
    t3: inputs.t3,
    workflowMcpEndpoint: `http://${loaded.server.host}:${loaded.server.port}/mcp`,
  };
};

export const createConfiguredProductionComposition = async (
  loaded: LoadedDeploymentConfiguration,
  dependencies: ConfiguredProductionServiceDependencies = {},
): Promise<ProductionComposition> => {
  const inputs = await configuredCompositionInputs(loaded, dependencies);
  return createProductionComposition(
    productionOptions(loaded, dependencies, inputs),
  );
};

export const startConfiguredProductionService = async (
  loaded: LoadedDeploymentConfiguration,
  dependencies: ConfiguredProductionServiceDependencies = {},
): Promise<HeddleDeploymentServer> => {
  const inputs = await configuredCompositionInputs(loaded, dependencies);
  const options = productionOptions(loaded, dependencies, inputs);
  options.onSchedulerError ??= (error) => {
    process.stderr.write(
      `Heddle reconciliation pass failed: ${describeError(error)}\n`,
    );
  };
  return startHeddleServer(
    { host: loaded.server.host, port: loaded.server.port },
    { productionFactory: () => createProductionComposition(options) },
  );
};
