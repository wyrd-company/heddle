import { describe, expect, it } from "vitest";

import { EnvironmentHttpCommonError, McpRouteError } from "./http-errors.js";

describe("HTTP error schemas", () => {
  it("discriminates tagged environment errors", () => {
    expect(
      EnvironmentHttpCommonError.parse({
        _tag: "EnvironmentScopeRequiredError",
        code: "insufficient_scope",
        requiredScope: "orchestration:operate",
        traceId: "trace-1",
      }),
    ).toMatchObject({ code: "insufficient_scope" });
  });

  it("decodes the MCP error shape", () => {
    expect(
      McpRouteError.parse({ error: "insufficient_scope", requiredScope: "orchestration:operate" }),
    ).toMatchObject({ requiredScope: "orchestration:operate" });
  });
});
