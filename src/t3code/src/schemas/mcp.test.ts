import { describe, expect, it } from "vitest";

import { ExternalMcpRegistration } from "./mcp.js";

describe("ExternalMcpRegistration", () => {
  it("accepts the route contract and refuses the internal name", () => {
    expect(
      ExternalMcpRegistration.safeParse({
        threadId: "record-1",
        endpoint: "http://127.0.0.1:3000/mcp",
        authorizationHeader: "Bearer credential-1",
      }).success,
    ).toBe(true);
    expect(
      ExternalMcpRegistration.safeParse({
        threadId: "record-1",
        name: "t3-code",
        endpoint: "https://example.invalid/mcp",
        authorizationHeader: "Bearer credential-1",
      }).success,
    ).toBe(false);
  });
});
