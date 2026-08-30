// ---
// relationships:
//   implements: heddle
// ---

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";

import type {
  ProviderUsageSource,
  ProviderUsageWindow,
} from "../pacing/index.js";
import type { ExecutableProviderUsageConfiguration } from "./configuration.js";

const protocolVersion = 1;
const usageWindowHours = 5;
const maximumResponseBytes = 64 * 1024;
const forcedTerminationDelayMilliseconds = 50;

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
    const request = `${JSON.stringify({
      provider,
      version: protocolVersion,
      windowHours: usageWindowHours,
    })}\n`;
    const source = await new Promise<string>((resolve, reject) => {
      let child;
      try {
        child = spawn(
          this.configuration.executable,
          [...this.configuration.arguments],
          {
            shell: false,
            stdio: ["pipe", "pipe", "ignore"],
            windowsHide: true,
          },
        );
      } catch {
        reject(
          new ProviderUsageCommandError(
            `Provider usage executable '${this.configuration.executable}' could not start`,
          ),
        );
        return;
      }

      const chunks: Buffer[] = [];
      let responseBytes = 0;
      let responseTooLarge = false;
      let inputFailed = false;
      let timedOut = false;
      let settled = false;
      let forcedTermination:
        ReturnType<typeof globalThis.setTimeout> | undefined;
      const timeout = globalThis.setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        forcedTermination = globalThis.setTimeout(() => {
          child.kill("SIGKILL");
        }, forcedTerminationDelayMilliseconds);
      }, this.configuration.timeoutMilliseconds);
      const settle = (error: Error | undefined, output?: string): void => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeout);
        if (forcedTermination !== undefined) {
          globalThis.clearTimeout(forcedTermination);
        }
        if (error === undefined) resolve(output ?? "");
        else reject(error);
      };

      child.stdout.on("data", (chunk: Buffer) => {
        responseBytes += chunk.length;
        if (responseBytes > maximumResponseBytes) {
          responseTooLarge = true;
          child.kill("SIGKILL");
          return;
        }
        chunks.push(chunk);
      });
      child.once("error", () => {
        settle(
          new ProviderUsageCommandError(
            `Provider usage executable '${this.configuration.executable}' could not start`,
          ),
        );
      });
      child.once("close", (code, signal) => {
        if (timedOut) {
          settle(
            new ProviderUsageCommandError(
              `Provider usage command exceeded ${this.configuration.timeoutMilliseconds}ms`,
            ),
          );
          return;
        }
        if (responseTooLarge) {
          settle(
            new ProviderUsageCommandError(
              `Provider usage command response exceeded ${maximumResponseBytes} bytes`,
            ),
          );
          return;
        }
        if (inputFailed) {
          settle(
            new ProviderUsageCommandError(
              "Provider usage command did not accept its complete request",
            ),
          );
          return;
        }
        if (signal !== null) {
          settle(
            new ProviderUsageCommandError(
              `Provider usage command terminated by signal ${signal}`,
            ),
          );
          return;
        }
        if (code !== 0) {
          settle(
            new ProviderUsageCommandError(
              `Provider usage command exited with status ${code ?? "unknown"}`,
            ),
          );
          return;
        }
        settle(undefined, Buffer.concat(chunks).toString("utf8"));
      });
      child.stdin.on("error", () => {
        inputFailed = true;
      });
      child.stdin.end(request);
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
