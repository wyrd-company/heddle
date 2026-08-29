// ---
// relationships:
//   implements: heddle
// ---

import type { PacingConfiguration } from "../pacing/index.js";

export type ProductionSessionConfiguration = {
  baseRef: string;
  cliVersion: string;
  driver: string;
  interactionMode: string;
  model: string;
  repositoryName: string;
  runtimeMode: string;
  skillPointer: string;
  worktreesRoot?: string;
};

export type PushoverConfiguration = {
  apiUrl: string;
  applicationToken: string;
  consoleBaseUrl: string;
  userKey: string;
};

export type ProductionConfiguration = {
  boardDirectory: string;
  cadenceMilliseconds: number;
  pacing: PacingConfiguration;
  observationThresholds: {
    endedMilliseconds: number;
    failedMilliseconds: number;
    stalledMilliseconds: number;
  };
  projectId: string;
  pushover: PushoverConfiguration;
  repositoryRoot: string;
  session: ProductionSessionConfiguration;
  stageThresholds: Readonly<Record<string, number>>;
  stateDirectory: string;
  stopTimeoutMilliseconds: number;
  t3: { accessToken: string; baseUrl: string };
};

const requireAbsolute = (name: string, value: string): void => {
  if (!value.startsWith("/")) throw new TypeError(`${name} must be absolute`);
};

const requireNonEmpty = (name: string, value: string): void => {
  if (value.trim() === "") throw new TypeError(`${name} must not be empty`);
};

const requirePositiveInteger = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
};

export const validateProductionConfiguration = (
  configuration: ProductionConfiguration,
): ProductionConfiguration => {
  requireAbsolute("boardDirectory", configuration.boardDirectory);
  requireAbsolute("repositoryRoot", configuration.repositoryRoot);
  requireAbsolute("stateDirectory", configuration.stateDirectory);
  requirePositiveInteger(
    "cadenceMilliseconds",
    configuration.cadenceMilliseconds,
  );
  requirePositiveInteger(
    "stopTimeoutMilliseconds",
    configuration.stopTimeoutMilliseconds,
  );
  requireNonEmpty("projectId", configuration.projectId);
  requireNonEmpty("t3.baseUrl", configuration.t3.baseUrl);
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
  for (const [name, value] of Object.entries(configuration.session)) {
    if (value !== undefined) requireNonEmpty(`session.${name}`, value);
  }
  if (configuration.pacing.defaultProvider !== configuration.session.driver) {
    throw new TypeError(
      "pacing.defaultProvider must equal session.driver for the configured session provider",
    );
  }
  requireNonEmpty("pushover.apiUrl", configuration.pushover.apiUrl);
  requireNonEmpty(
    "pushover.applicationToken",
    configuration.pushover.applicationToken,
  );
  requireNonEmpty(
    "pushover.consoleBaseUrl",
    configuration.pushover.consoleBaseUrl,
  );
  requireNonEmpty("pushover.userKey", configuration.pushover.userKey);
  return configuration;
};
