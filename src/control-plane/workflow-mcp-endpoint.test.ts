// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import { requireWorkflowMcpEndpoint } from "./workflow-mcp-endpoint.js";

describe("workflow MCP endpoint", () => {
  it.each([
    "http://localhost:4774/mcp",
    "http://service.localhost:4774/mcp",
    "http://127.42.3.4:4774/mcp",
    "http://[::1]:4774/mcp",
    "https://service.invalid/mcp",
  ])("accepts a secure transport to %s", (endpoint) => {
    expect(requireWorkflowMcpEndpoint(endpoint)).toBe(endpoint);
  });

  it.each([
    "http://0.0.0.0:4774/mcp",
    "http://192.0.2.10:4774/mcp",
    "http://127.example.invalid/mcp",
    "http://service.invalid/mcp",
    "http://[::]:4774/mcp",
  ])("rejects cleartext transport to non-loopback endpoint %s", (endpoint) => {
    expect(() => requireWorkflowMcpEndpoint(endpoint)).toThrow(
      "workflowMcpEndpoint must use HTTPS unless its hostname is loopback",
    );
  });
});
