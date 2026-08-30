// ---
// relationships:
//   implements: heddle
// ---

import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { URL } from "node:url";

import { Ajv2020, type AnySchema, type ErrorObject } from "ajv/dist/2020.js";
import { parseDocument } from "yaml";

import {
  validateProductionConfiguration,
  type ProductionConfiguration,
} from "../production/index.js";

const defaultConfigurationDirectory = "/home/vscode/.heddle";
const configurationFileName = "config.yml";

type DeploymentEnvironment = Record<string, string | undefined>;

export type DeploymentServerConfiguration = {
  host: string;
  port: number;
};

export type LoadedDeploymentConfiguration = {
  configuration: ProductionConfiguration;
  configurationDirectory: string;
  configurationPath: string;
  server: DeploymentServerConfiguration;
};

type ConfigurationDocument = ProductionConfiguration & {
  server: DeploymentServerConfiguration;
};

export class HeddleConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "HeddleConfigurationError";
  }
}

const requireAbsoluteDirectory = (value: string, source: string): string => {
  const directory = value.trim();
  if (directory === "") {
    throw new HeddleConfigurationError(`${source} must not be empty`);
  }
  if (!isAbsolute(directory)) {
    throw new HeddleConfigurationError(`${source} must be an absolute path`);
  }
  return directory;
};

export const resolveConfigurationDirectory = (
  arguments_: readonly string[],
  environment: DeploymentEnvironment,
): string => {
  if (arguments_.length > 0) {
    if (arguments_.length !== 2 || arguments_[0] !== "--config") {
      throw new HeddleConfigurationError(
        "Usage: heddle-server [--config <configuration-directory>]",
      );
    }
    return requireAbsoluteDirectory(arguments_[1]!, "--config");
  }
  const configured = environment["HEDDLE_CONFIG"];
  return configured === undefined
    ? defaultConfigurationDirectory
    : requireAbsoluteDirectory(configured, "HEDDLE_CONFIG");
};

const secretValues = (value: unknown): string[] => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  const root = value as Record<string, unknown>;
  const strings: string[] = [];
  for (const [section, names] of [
    ["t3", ["accessToken"]],
    ["pushover", ["applicationToken", "userKey"]],
  ] as const) {
    const candidate = root[section];
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      continue;
    }
    for (const name of names) {
      const secret = (candidate as Record<string, unknown>)[name];
      if (typeof secret === "string" && secret !== "") strings.push(secret);
    }
  }
  return strings;
};

const redact = (message: string, secrets: readonly string[]): string =>
  secrets.reduce(
    (result, secret) => result.split(secret).join("[REDACTED]"),
    message,
  );

const firstSchemaError = (error: ErrorObject | undefined): string => {
  if (error === undefined) return "configuration does not match its schema";
  const location = error.instancePath === "" ? "/" : error.instancePath;
  const detail = Object.values(error.params).find(
    (value): value is string => typeof value === "string" && value !== "",
  );
  return `${location} ${error.message ?? "is invalid"}${detail === undefined ? "" : `: ${detail}`}`;
};

const readConfigurationSchema = async (): Promise<AnySchema> =>
  JSON.parse(
    await readFile(
      new URL("../../schemas/production-configuration.json", import.meta.url),
      "utf8",
    ),
  ) as AnySchema;

export const loadDeploymentConfiguration = async (
  configurationDirectory: string,
): Promise<LoadedDeploymentConfiguration> => {
  const directory = requireAbsoluteDirectory(
    configurationDirectory,
    "configuration directory",
  );
  const configurationPath = join(directory, configurationFileName);
  let source: string;
  try {
    source = await readFile(configurationPath, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    const description = code === "ENOENT" ? "is missing" : "cannot be read";
    throw new HeddleConfigurationError(
      `Configuration file '${configurationPath}' ${description}`,
    );
  }

  let value: unknown;
  try {
    const document = parseDocument(source, {
      prettyErrors: false,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) throw new Error("invalid YAML");
    value = document.toJS({ maxAliasCount: 100 }) as unknown;
  } catch {
    throw new HeddleConfigurationError(
      `Configuration file '${configurationPath}' is invalid YAML`,
    );
  }
  const secrets = secretValues(value);
  try {
    const validator = new Ajv2020({
      allErrors: true,
      formats: { uri: true },
      strict: false,
      useDefaults: true,
    }).compile(await readConfigurationSchema());
    if (!validator(value)) {
      throw new TypeError(firstSchemaError(validator.errors?.[0]));
    }
    const { server, ...configuration } = value as ConfigurationDocument;
    if (server.host.trim() === "") {
      throw new TypeError("/server/host must not be empty");
    }
    return {
      configuration: validateProductionConfiguration(configuration),
      configurationDirectory: directory,
      configurationPath,
      server: { ...server, host: server.host.trim() },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    throw new HeddleConfigurationError(
      `Configuration file '${configurationPath}' is invalid: ${redact(message, secrets)}`,
    );
  }
};
