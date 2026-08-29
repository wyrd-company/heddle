// ---
// relationships:
//   implements: heddle
// ---

export type HarnessToolTimeoutConfiguration = {
  claudeCode: { environment: { MCP_TOOL_TIMEOUT: "100000000" } };
  codex: { mcp_servers: { heddle: { tool_timeout_sec: 100_000 } } };
};

export const harnessToolTimeoutConfiguration =
  (): HarnessToolTimeoutConfiguration => ({
    claudeCode: { environment: { MCP_TOOL_TIMEOUT: "100000000" } },
    codex: { mcp_servers: { heddle: { tool_timeout_sec: 100_000 } } },
  });
