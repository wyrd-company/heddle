// ---
// relationships:
//   implements: heddle
// ---

export type HarnessToolTimeoutConfiguration = {
  claudeCode: { environment: { MCP_TOOL_TIMEOUT: "100000000" } };
  codex: { mcp_servers: { heddle: { tool_timeout_sec: 100_000 } } };
};

export type HarnessToolTimeoutLaunchConfiguration =
  | {
      configuration: HarnessToolTimeoutConfiguration["claudeCode"];
      driver: "claudeAgent";
    }
  | {
      configuration: HarnessToolTimeoutConfiguration["codex"];
      driver: "codex";
    };

export type HarnessToolTimeoutLaunchInput =
  HarnessToolTimeoutLaunchConfiguration & {
    sessionKey: string;
    threadId: string;
    worktreePath: string;
  };

export type HarnessToolTimeoutConsumer = (
  input: HarnessToolTimeoutLaunchInput,
) => Promise<void>;

export const harnessToolTimeoutConfiguration =
  (): HarnessToolTimeoutConfiguration => ({
    claudeCode: { environment: { MCP_TOOL_TIMEOUT: "100000000" } },
    codex: { mcp_servers: { heddle: { tool_timeout_sec: 100_000 } } },
  });

export const harnessToolTimeoutLaunchConfiguration = (
  driver: string,
): HarnessToolTimeoutLaunchConfiguration | undefined => {
  const configured = harnessToolTimeoutConfiguration();
  if (driver === "claudeAgent") {
    return { configuration: configured.claudeCode, driver };
  }
  if (driver === "codex") {
    return { configuration: configured.codex, driver };
  }
  return undefined;
};

export const applyHarnessToolTimeoutBeforeThread = async (input: {
  consumer?: HarnessToolTimeoutConsumer;
  driver: string;
  sessionKey: string;
  threadId: string;
  worktreePath: string;
}): Promise<void> => {
  const configured = harnessToolTimeoutLaunchConfiguration(input.driver);
  if (configured === undefined) return;
  if (input.consumer === undefined) {
    throw new Error(
      `Harness tool timeout application is required for provider '${configured.driver}'`,
    );
  }
  await input.consumer({
    ...configured,
    sessionKey: input.sessionKey,
    threadId: input.threadId,
    worktreePath: input.worktreePath,
  });
};
