// ---
// relationships:
//   implements: heddle
// ---

import type { ConfigurationProvenance } from "./configuration-layering.js";
import {
  configurationSecretValues,
  redactConfigurationText,
  redactedConfigurationValue,
} from "./configuration-redaction.js";
import type { LoadedDeploymentConfiguration } from "./configuration.js";

export type EffectiveConfigurationDisclosure = {
  cleared: ConfigurationProvenance;
  configuration: unknown;
  provenance: ConfigurationProvenance;
  sources: {
    builtIn: "built-in";
    core: string;
    worker?: string;
  };
};

const redactedProvenance = (
  provenance: ConfigurationProvenance,
  secrets: readonly string[],
): ConfigurationProvenance =>
  Object.fromEntries(
    Object.entries(provenance).map(([pointer, source]) => [
      redactConfigurationText(pointer, secrets),
      redactConfigurationText(source, secrets),
    ]),
  );

export const buildEffectiveConfigurationDisclosure = (
  loaded: LoadedDeploymentConfiguration,
  secrets: readonly string[],
): EffectiveConfigurationDisclosure => {
  const configuration = {
    ...loaded.configuration,
    ...(loaded.providerUsage === undefined
      ? {}
      : { providerUsage: loaded.providerUsage }),
    server: loaded.server,
  };
  return {
    cleared: redactedProvenance(loaded.configurationClearedBy ?? {}, secrets),
    configuration: redactedConfigurationValue(configuration, secrets),
    provenance: redactedProvenance(
      loaded.configurationProvenance ?? {},
      secrets,
    ),
    sources: {
      builtIn: "built-in",
      core: redactConfigurationText(loaded.configurationPath, secrets),
      ...(loaded.workerConfigurationPath === undefined
        ? {}
        : {
            worker: redactConfigurationText(
              loaded.workerConfigurationPath,
              secrets,
            ),
          }),
    },
  };
};

export const effectiveConfigurationDisclosure = (
  loaded: LoadedDeploymentConfiguration,
): EffectiveConfigurationDisclosure =>
  loaded.effectiveConfigurationDisclosure ??
  buildEffectiveConfigurationDisclosure(
    loaded,
    configurationSecretValues({
      ...loaded.configuration,
      ...(loaded.providerUsage === undefined
        ? {}
        : { providerUsage: loaded.providerUsage }),
      server: loaded.server,
    }),
  );
