// ---
// relationships:
//   implements: heddle
// ---

import { URL } from "node:url";

import type { PacingConfiguration } from "../pacing/index.js";

export type ProductionSessionConfiguration = {
  baseRef: string;
  cliVersion: string;
  driver: string;
  interactionMode: string;
  model: string;
  runtimeMode: string;
  skillPointer: string;
  worktreesRoot?: string;
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
  userKey: string;
};

export type ProductionConfiguration = {
  adHocProject: AdHocProjectConfiguration;
  boardDirectory: string;
  cadenceMilliseconds: number;
  pacing: PacingConfiguration;
  observationThresholds: {
    endedMilliseconds: number;
    failedMilliseconds: number;
    stalledMilliseconds: number;
  };
  products: ProductConfiguration[];
  pushover: PushoverConfiguration;
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

export const validateProductionConfiguration = (
  configuration: ProductionConfiguration,
): ProductionConfiguration => {
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
  for (const [name, value] of Object.entries(configuration.session)) {
    if (value !== undefined) requireNonEmpty(`session.${name}`, value);
  }
  if (configuration.pacing.defaultProvider !== configuration.session.driver) {
    throw new TypeError(
      "pacing.defaultProvider must equal session.driver for the configured session provider",
    );
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
  requireNonEmpty("pushover.userKey", configuration.pushover.userKey);
  return configuration;
};
