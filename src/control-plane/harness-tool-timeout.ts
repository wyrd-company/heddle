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
    }
  | {
      configuration: Record<string, never>;
      driver: string;
    };

export type HarnessToolTimeoutLaunchInput =
  HarnessToolTimeoutLaunchConfiguration & {
    providerInstanceId: string;
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
): HarnessToolTimeoutLaunchConfiguration => {
  const configured = harnessToolTimeoutConfiguration();
  if (driver === "claudeAgent") {
    return { configuration: configured.claudeCode, driver };
  }
  if (driver === "codex") {
    return { configuration: configured.codex, driver };
  }
  return { configuration: {}, driver };
};

export const applyHarnessToolTimeoutBeforeThread = async (input: {
  consumer?: HarnessToolTimeoutConsumer;
  driver: string;
  providerInstanceId: string;
  sessionKey: string;
  threadId: string;
  worktreePath: string;
}): Promise<void> => {
  const configured = harnessToolTimeoutLaunchConfiguration(input.driver);
  if (input.consumer === undefined) return;
  await input.consumer({
    ...configured,
    providerInstanceId: input.providerInstanceId,
    sessionKey: input.sessionKey,
    threadId: input.threadId,
    worktreePath: input.worktreePath,
  });
};
