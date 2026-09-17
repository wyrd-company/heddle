import { describe, expect, it } from "vitest";

import { T3AuthError } from "../errors.js";
import { ensureScopes, hasScope } from "./scopes.js";

describe("scope helpers", () => {
  it("checks and requires scopes", () => {
    expect(hasScope(["orchestration:read"], "orchestration:read")).toBe(true);
    expect(hasScope(undefined, "orchestration:read")).toBe(false);
    expect(() => ensureScopes(["orchestration:read"], ["access:write"])).toThrow(T3AuthError);
  });
});
