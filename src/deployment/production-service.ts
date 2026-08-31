// ---
// relationships:
//   implements: heddle
// ---

import process from "node:process";

import { T3ControlPlaneClient } from "../control-plane/index.js";
import { describeError } from "../error-details.js";
import type { ProviderUsageSource } from "../pacing/index.js";
import {
  createProductionComposition,
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
>;

const providerUsageSource = (
  loaded: LoadedDeploymentConfiguration,
): ProviderUsageSource =>
  loaded.providerUsage === undefined
    ? createUnconfiguredProviderUsageSource()
    : new ExecutableProviderUsageSource(loaded.providerUsage);

const t3Client = (loaded: LoadedDeploymentConfiguration): ProductionT3Client =>
  loaded.timeoutApplication === undefined
    ? new T3ControlPlaneClient(loaded.configuration.t3)
    : new ConfiguredT3ControlPlaneClient(
        loaded.configuration.t3,
        loaded.timeoutApplication,
      );

export const createConfiguredProductionComposition = (
  loaded: LoadedDeploymentConfiguration,
  dependencies: ConfiguredProductionServiceDependencies = {},
): ProductionComposition =>
  createProductionComposition({
    ...dependencies,
    blueprintsRepositoryRoot: loaded.blueprintsRepositoryRoot,
    configuration: loaded.configuration,
    providerUsage: providerUsageSource(loaded),
    resolveSystemPrompt: configurationDirectorySystemPromptResolver(
      loaded.configurationDirectory,
    ),
    t3: dependencies.t3 ?? t3Client(loaded),
  });

export const startConfiguredProductionService = async (
  loaded: LoadedDeploymentConfiguration,
  dependencies: ConfiguredProductionServiceDependencies = {},
): Promise<HeddleDeploymentServer> =>
  startHeddleServer(
    { host: loaded.server.host, port: loaded.server.port },
    {
      productionFactory: () =>
        createConfiguredProductionComposition(loaded, {
          ...dependencies,
          onSchedulerError:
            dependencies.onSchedulerError ??
            ((error) => {
              process.stderr.write(
                `Heddle reconciliation pass failed: ${describeError(error)}\n`,
              );
            }),
        }),
    },
  );
