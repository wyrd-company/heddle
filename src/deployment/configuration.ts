// ---
// relationships:
//   implements: heddle
// ---

import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { access, open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { URL } from "node:url";
import { promisify } from "node:util";

import { Ajv2020, type AnySchema, type ErrorObject } from "ajv/dist/2020.js";
import { parseDocument } from "yaml";

import {
  validateProductionConfiguration,
  type ProductionConfiguration,
} from "../production/index.js";
import {
  completeConfigurationProvenance,
  layerConfiguration,
  sourceForConfigurationPointer,
  type ConfigurationProvenance,
} from "./configuration-layering.js";
import {
  configurationSecretValues,
  redactConfigurationText,
} from "./configuration-redaction.js";
import {
  buildEffectiveConfigurationDisclosure,
  type EffectiveConfigurationDisclosure,
} from "./configuration-disclosure.js";

export {
  effectiveConfigurationDisclosure,
  type EffectiveConfigurationDisclosure,
} from "./configuration-disclosure.js";

const defaultConfigurationDirectory = "/home/vscode/.heddle";
const configurationFileName = "config.yml";
const workerConfigurationFileName = "worker.yml";
const blueprintsDirectoryName = "blueprints";
const execute = promisify(execFile);

type DeploymentEnvironment = Record<string, string | undefined>;

export type DeploymentServerConfiguration = {
  host: string;
  port: number;
};

export type LoadedDeploymentConfiguration = {
  blueprintsSourceRoot: string;
  blueprintsRepositoryRoot: string;
  configuration: ProductionConfiguration;
  configurationClearedBy?: ConfigurationProvenance;
  configurationDirectory: string;
  configurationPath: string;
  configurationProvenance?: ConfigurationProvenance;
  effectiveConfigurationDisclosure?: EffectiveConfigurationDisclosure;
  providerUsage?: ExecutableProviderUsageConfiguration;
  server: DeploymentServerConfiguration;
  workerConfigurationPath?: string;
};

export type ExecutableProviderUsageConfiguration = {
  arguments: string[];
  executable: string;
  timeoutMilliseconds: number;
};

export type HeddleServerArguments = {
  command: "effective-configuration" | "help" | "launch-settings" | "serve";
  configurationDirectory?: string;
};

type ConfigurationDocument = Omit<ProductionConfiguration, "session"> & {
  providerUsage?: ExecutableProviderUsageConfiguration;
  server: Pick<DeploymentServerConfiguration, "port">;
  session: ProductionConfiguration["session"];
};

const deploymentServerHost = "127.0.0.1";

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

export const parseHeddleServerArguments = (
  arguments_: readonly string[],
  environment: DeploymentEnvironment,
): HeddleServerArguments => {
  if (arguments_.length === 1 && arguments_[0] === "--help") {
    return { command: "help" };
  }
  const diagnosticFlags = arguments_.filter((argument) =>
    ["--print-effective-configuration", "--print-launch-settings"].includes(
      argument,
    ),
  );
  if (diagnosticFlags.length > 1) {
    throw new HeddleConfigurationError(
      "Choose one configuration diagnostic output",
    );
  }
  const command =
    diagnosticFlags[0] === "--print-launch-settings"
      ? "launch-settings"
      : diagnosticFlags[0] === "--print-effective-configuration"
        ? "effective-configuration"
        : "serve";
  const configurationArguments = arguments_.filter(
    (argument) => argument !== diagnosticFlags[0],
  );
  return {
    command,
    configurationDirectory: resolveConfigurationDirectory(
      configurationArguments,
      environment,
    ),
  };
};

export const deploymentLaunchSettings = (
  loaded: LoadedDeploymentConfiguration,
): { host: string; port: number; stateDirectory: string } => ({
  host: loaded.server.host,
  port: loaded.server.port,
  stateDirectory: loaded.configuration.stateDirectory,
});

const firstSchemaError = (
  error: ErrorObject | undefined,
): { detail: string; pointer: string } => {
  if (error === undefined) {
    return {
      detail: "configuration does not match its schema",
      pointer: "",
    };
  }
  const location = error.instancePath === "" ? "/" : error.instancePath;
  const detail = Object.values(error.params).find(
    (value): value is string => typeof value === "string" && value !== "",
  );
  const property =
    error.keyword === "required"
      ? error.params["missingProperty"]
      : error.keyword === "additionalProperties"
        ? error.params["additionalProperty"]
        : undefined;
  const pointer =
    typeof property === "string"
      ? `${error.instancePath}/${property.replaceAll("~", "~0").replaceAll("/", "~1")}`
      : error.instancePath;
  return {
    detail: `${location} ${error.message ?? "is invalid"}${detail === undefined ? "" : `: ${detail}`}`,
    pointer,
  };
};

const readConfigurationSchema = async (): Promise<AnySchema> =>
  JSON.parse(
    await readFile(
      new URL("../../schemas/production-configuration.json", import.meta.url),
      "utf8",
    ),
  ) as AnySchema;

export const validateProviderUsageConfiguration = (
  configuration: ProductionConfiguration,
  providerUsage: ExecutableProviderUsageConfiguration | undefined,
): void => {
  const hasProviderBudgets =
    Object.keys(configuration.pacing.providerBudgets).length > 0;
  if (hasProviderBudgets !== (providerUsage !== undefined)) {
    throw new TypeError(
      hasProviderBudgets
        ? "providerUsage is required when pacing.providerBudgets is non-empty"
        : "providerUsage must be omitted when pacing.providerBudgets is empty",
    );
  }
};

const preflightExecutable = async (
  field: string,
  configuration: ExecutableProviderUsageConfiguration | undefined,
): Promise<void> => {
  if (configuration === undefined) return;
  try {
    const metadata = await stat(configuration.executable);
    if (!metadata.isFile()) throw new Error("not a file");
    await access(configuration.executable, constants.X_OK);
  } catch {
    throw new TypeError(
      `${field}.executable '${configuration.executable}' must be an available executable file`,
    );
  }
};

const preflightBlueprintSource = async (
  configurationDirectory: string,
): Promise<string> => {
  const repositoryRoot = join(configurationDirectory, blueprintsDirectoryName);
  try {
    const metadata = await stat(repositoryRoot);
    if (!metadata.isDirectory()) throw new Error("not a directory");
    const [{ stdout: topLevel }, { stdout: upstream }] = await Promise.all([
      execute("git", ["rev-parse", "--show-toplevel"], {
        cwd: repositoryRoot,
      }),
      execute(
        "git",
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        { cwd: repositoryRoot },
      ),
    ]);
    if (
      (await realpath(topLevel.trim())) !== (await realpath(repositoryRoot)) ||
      !upstream.trim().startsWith("origin/")
    ) {
      throw new Error("not the tracked organization clone root");
    }
    return repositoryRoot;
  } catch {
    throw new TypeError(
      `Blueprint source '${repositoryRoot}' must be a git clone root whose current branch tracks origin`,
    );
  }
};

const readConfigurationDocument = async (
  path: string,
  required: boolean,
): Promise<unknown | undefined> => {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    if (!required && code === "ENOENT") return undefined;
    const description = code === "ENOENT" ? "is missing" : "cannot be read";
    throw new HeddleConfigurationError(
      `Configuration file '${path}' ${description}`,
    );
  }
  try {
    const document = parseDocument(source, {
      prettyErrors: false,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) throw new Error("invalid YAML");
    return document.toJS({ maxAliasCount: 100 }) as unknown;
  } catch {
    throw new HeddleConfigurationError(
      `Configuration file '${path}' is invalid YAML`,
    );
  }
};

const runtimeValidationPointer = (message: string): string => {
  const field = /^([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*)/.exec(
    message,
  )?.[1];
  return field === undefined ? "" : `/${field.replaceAll(".", "/")}`;
};

const declaresServerHost = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const server = (value as Record<string, unknown>)["server"];
  return (
    typeof server === "object" &&
    server !== null &&
    !Array.isArray(server) &&
    Object.hasOwn(server, "host")
  );
};

const secretReferencePointers = [
  "/t3/accessToken",
  "/pushover/applicationToken",
  "/pushover/userKey",
] as const;

type SecretReference = { file: string };

type SecretFileFailure =
  | "is missing"
  | "cannot be read"
  | "is not a regular file"
  | "is readable by group or world"
  | "is empty";

const valueAtConfigurationPointer = (
  root: unknown,
  pointer: string,
): unknown => {
  let value = root;
  for (const segment of pointer.slice(1).split("/")) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
};

const setConfigurationPointer = (
  root: Record<string, unknown>,
  pointer: string,
  value: string,
): void => {
  const segments = pointer.slice(1).split("/");
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = parent[segment] as Record<string, unknown>;
  }
  parent[segments.at(-1)!] = value;
};

const isSecretReference = (value: unknown): value is SecretReference =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as Record<string, unknown>)["file"] === "string";

export const resolveSecretReferencePath = (
  field: string,
  reference: string,
  layered: Pick<
    ReturnType<typeof layerConfiguration>,
    "clearedBy" | "provenance"
  >,
): string => {
  if (isAbsolute(reference)) return reference;
  const source = sourceForConfigurationPointer(`${field}/file`, layered);
  return resolve(dirname(source), reference);
};

const readSecretReference = async (
  field: string,
  path: string,
): Promise<string> => {
  const failure = (reason: SecretFileFailure): TypeError =>
    new TypeError(`field '${field}' secret file '${path}' ${reason}`);
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      throw failure("is missing");
    }
    throw failure("cannot be read");
  }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw failure("is not a regular file");
    if ((metadata.mode & (constants.S_IRGRP | constants.S_IROTH)) !== 0) {
      throw failure("is readable by group or world");
    }
    let value: string;
    try {
      value = await file.readFile({ encoding: "utf8" });
    } catch {
      throw failure("cannot be read");
    }
    value = value.replace(/\r?\n$/, "");
    if (value === "") throw failure("is empty");
    return value;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw failure("cannot be read");
  } finally {
    await file.close();
  }
};

const resolveSecretReferences = async (
  value: unknown,
  layered: Pick<
    ReturnType<typeof layerConfiguration>,
    "clearedBy" | "provenance"
  >,
): Promise<{ secrets: string[]; value: unknown }> => {
  const resolved = globalThis.structuredClone(value) as Record<string, unknown>;
  const secrets: string[] = [];
  for (const pointer of secretReferencePointers) {
    const candidate = valueAtConfigurationPointer(resolved, pointer);
    if (!isSecretReference(candidate)) continue;
    const path = resolveSecretReferencePath(pointer, candidate.file, layered);
    const secret = await readSecretReference(pointer, path);
    setConfigurationPointer(resolved, pointer, secret);
    secrets.push(secret);
  }
  return { secrets, value: resolved };
};

export const loadDeploymentConfiguration = async (
  configurationDirectory: string,
): Promise<LoadedDeploymentConfiguration> => {
  const directory = requireAbsoluteDirectory(
    configurationDirectory,
    "configuration directory",
  );
  const configurationPath = join(directory, configurationFileName);
  const workerConfigurationPath = join(directory, workerConfigurationFileName);
  const core = await readConfigurationDocument(configurationPath, true);
  const coreSecrets = configurationSecretValues(core);
  let worker: unknown | undefined;
  try {
    worker = await readConfigurationDocument(workerConfigurationPath, false);
  } catch (error) {
    throw new HeddleConfigurationError(
      redactConfigurationText(
        error instanceof Error ? error.message : "unknown error",
        coreSecrets,
      ),
    );
  }
  const configurationLayers = [
    { source: configurationPath, value: core },
    ...(worker === undefined || worker === null
      ? []
      : [{ source: workerConfigurationPath, value: worker }]),
  ];
  const layered = layerConfiguration(configurationLayers);
  const value = layered.value;
  const secrets = [...coreSecrets, ...configurationSecretValues(worker)];
  try {
    const serverHostSource = configurationLayers.find(({ value }) =>
      declaresServerHost(value),
    );
    if (serverHostSource !== undefined) {
      throw new TypeError(
        `field '/server/host' from '${serverHostSource.source}': server.host is internal and cannot be configured`,
      );
    }
    const validator = new Ajv2020({
      allErrors: true,
      formats: { uri: true },
      strict: false,
      useDefaults: true,
    }).compile(await readConfigurationSchema());
    if (!validator(value)) {
      const failure = firstSchemaError(validator.errors?.[0]);
      const source = (() => {
        if (validator.errors?.[0]?.keyword !== "required") {
          return sourceForConfigurationPointer(failure.pointer, layered);
        }
        if (layered.clearedBy[failure.pointer] !== undefined) {
          return sourceForConfigurationPointer(failure.pointer, layered);
        }
        const parentPointer = failure.pointer.slice(
          0,
          failure.pointer.lastIndexOf("/"),
        );
        if (parentPointer === "") return configurationPath;
        const source = sourceForConfigurationPointer(parentPointer, layered);
        return source === "built-in" ? configurationPath : source;
      })();
      throw new TypeError(
        `field '${failure.pointer || "/"}' from '${source}': ${failure.detail}`,
      );
    }
    const configurationProvenance = {
      ...completeConfigurationProvenance(value, layered.provenance),
      "/server/host": "built-in",
    };
    const resolvedSecrets = await resolveSecretReferences(value, layered);
    secrets.push(...resolvedSecrets.secrets);
    const document = resolvedSecrets.value as ConfigurationDocument;
    const { providerUsage, server, ...root } = document;
    const configuration: ProductionConfiguration = {
      ...root,
      session: document.session,
    };
    const invalidField = (pointer: string, message: string): TypeError =>
      new TypeError(
        `field '${pointer}' from '${sourceForConfigurationPointer(pointer, { ...layered, provenance: configurationProvenance })}': ${message}`,
      );
    let validated: ProductionConfiguration;
    try {
      validated = validateProductionConfiguration(configuration);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      const pointer = runtimeValidationPointer(message);
      throw invalidField(pointer || "/", message);
    }
    try {
      validateProviderUsageConfiguration(validated, providerUsage);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      throw invalidField(
        message.startsWith("providerUsage is required")
          ? "/pacing/providerBudgets"
          : "/providerUsage",
        message,
      );
    }
    try {
      await preflightExecutable("providerUsage", providerUsage);
    } catch (error) {
      throw invalidField(
        "/providerUsage/executable",
        error instanceof Error ? error.message : "unknown error",
      );
    }
    const blueprintsSourceRoot = await preflightBlueprintSource(directory);
    const blueprintsRepositoryRoot = join(
      validated.stateDirectory,
      blueprintsDirectoryName,
    );
    const checkoutFromSource = relative(
      resolve(blueprintsSourceRoot),
      resolve(blueprintsRepositoryRoot),
    );
    const sourceFromCheckout = relative(
      resolve(blueprintsRepositoryRoot),
      resolve(blueprintsSourceRoot),
    );
    const pathsOverlap = [checkoutFromSource, sourceFromCheckout].some(
      (path) =>
        path === "" ||
        (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)),
    );
    if (pathsOverlap) {
      throw invalidField(
        "/stateDirectory",
        "blueprint source and worker synchronization checkout must use disjoint paths",
      );
    }
    const loaded: LoadedDeploymentConfiguration = {
      blueprintsSourceRoot,
      blueprintsRepositoryRoot,
      configuration: validated,
      configurationClearedBy: layered.clearedBy,
      configurationDirectory: directory,
      configurationPath,
      configurationProvenance,
      ...(providerUsage === undefined
        ? {}
        : {
            providerUsage: {
              ...providerUsage,
              arguments: [...providerUsage.arguments],
            },
          }),
      server: { host: deploymentServerHost, port: server.port },
      ...(worker === undefined || worker === null
        ? {}
        : { workerConfigurationPath }),
    };
    return {
      ...loaded,
      effectiveConfigurationDisclosure: buildEffectiveConfigurationDisclosure(
        loaded,
        secrets,
      ),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    throw new HeddleConfigurationError(
      redactConfigurationText(
        `Configuration file '${configurationPath}' is invalid: ${message}`,
        secrets,
      ),
    );
  }
};
