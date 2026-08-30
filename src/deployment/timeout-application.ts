// ---
// relationships:
//   implements: heddle
// ---

import {
  T3ControlPlaneClient,
  type HarnessToolTimeoutLaunchInput,
  type T3ControlPlaneClientOptions,
} from "../control-plane/index.js";
import type { ExecutableTimeoutApplicationConfiguration } from "./configuration.js";
import { runExecutableJsonCommand } from "./executable-json-command.js";

const protocolVersion = 1;

export class TimeoutApplicationCommandError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TimeoutApplicationCommandError";
  }
}

const assertAcknowledgement = (source: string): void => {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new TimeoutApplicationCommandError(
      "Timeout application command returned malformed or extra output",
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TimeoutApplicationCommandError(
      "Timeout application command response must be one JSON object",
    );
  }
  const response = value as Record<string, unknown>;
  const keys = Object.keys(response).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "applied" ||
    keys[1] !== "version" ||
    response["version"] !== protocolVersion ||
    response["applied"] !== true
  ) {
    throw new TimeoutApplicationCommandError(
      "Timeout application command did not return the exact versioned success acknowledgement",
    );
  }
};

export class ConfiguredT3ControlPlaneClient extends T3ControlPlaneClient {
  private readonly timeoutApplication: ExecutableTimeoutApplicationConfiguration;

  public constructor(
    options: T3ControlPlaneClientOptions,
    timeoutApplication: ExecutableTimeoutApplicationConfiguration,
  ) {
    super(options);
    this.timeoutApplication = {
      ...timeoutApplication,
      arguments: [...timeoutApplication.arguments],
    };
  }

  public async applyHarnessToolTimeout(
    input: HarnessToolTimeoutLaunchInput,
  ): Promise<void> {
    const source = await runExecutableJsonCommand({
      configuration: this.timeoutApplication,
      error: (message) => new TimeoutApplicationCommandError(message),
      label: "Timeout application command",
      request: {
        configuration: input.configuration,
        driver: input.driver,
        sessionKey: input.sessionKey,
        threadId: input.threadId,
        version: protocolVersion,
        worktreePath: input.worktreePath,
      },
    });
    assertAcknowledgement(source);
  }
}
