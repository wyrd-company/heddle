// ---
// relationships:
//   implements: heddle
// ---

import type {
  ProviderUsageSource,
  ProviderUsageWindow,
} from "../pacing/index.js";
import type { ExecutableProviderUsageConfiguration } from "./configuration.js";
import { runExecutableJsonCommand } from "./executable-json-command.js";

const protocolVersion = 1;
const usageWindowHours = 5;

export class ProviderUsageCommandError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProviderUsageCommandError";
  }
}

const parseResponse = (source: string): ProviderUsageWindow => {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new ProviderUsageCommandError(
      "Provider usage command returned malformed or extra output",
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderUsageCommandError(
      "Provider usage command response must be one JSON object",
    );
  }
  const response = value as Record<string, unknown>;
  const keys = Object.keys(response).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "used" ||
    keys[1] !== "version" ||
    keys[2] !== "windowStartedAt"
  ) {
    throw new ProviderUsageCommandError(
      "Provider usage command response has an invalid shape",
    );
  }
  if (response["version"] !== protocolVersion) {
    throw new ProviderUsageCommandError(
      `Provider usage command response version must be ${protocolVersion}`,
    );
  }
  if (
    typeof response["used"] !== "number" ||
    !Number.isFinite(response["used"]) ||
    response["used"] < 0
  ) {
    throw new ProviderUsageCommandError(
      "Provider usage command response used must be a non-negative finite number",
    );
  }
  if (
    typeof response["windowStartedAt"] !== "number" ||
    !Number.isSafeInteger(response["windowStartedAt"]) ||
    response["windowStartedAt"] < 0
  ) {
    throw new ProviderUsageCommandError(
      "Provider usage command response windowStartedAt must be a non-negative safe integer",
    );
  }
  return {
    used: response["used"],
    windowStartedAt: response["windowStartedAt"],
  };
};

export class ExecutableProviderUsageSource implements ProviderUsageSource {
  private readonly configuration: ExecutableProviderUsageConfiguration;

  public constructor(configuration: ExecutableProviderUsageConfiguration) {
    this.configuration = {
      ...configuration,
      arguments: [...configuration.arguments],
    };
  }

  public async readFiveHourWindow(
    provider: string,
  ): Promise<ProviderUsageWindow> {
    const source = await runExecutableJsonCommand({
      configuration: this.configuration,
      error: (message) => new ProviderUsageCommandError(message),
      label: "Provider usage command",
      request: {
        provider,
        version: protocolVersion,
        windowHours: usageWindowHours,
      },
    });
    return parseResponse(source);
  }
}

export const createUnconfiguredProviderUsageSource =
  (): ProviderUsageSource => ({
    readFiveHourWindow: async () => {
      throw new ProviderUsageCommandError(
        "Provider usage was requested without a configured provider budget adapter",
      );
    },
  });
