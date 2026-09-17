// ---
// relationships:
//   verifies: github-client
// ---
import { describe, expect, it } from "vitest";

import { findLifecycleHookLocations } from "./check-codegen-hooks.mjs";

describe("GraphQL codegen lifecycle-hook detection", () => {
  it("reports a root lifecycle-hook location", () => {
    const config = { hooks: { afterAllFileWrite: ["example-command"] }, generates: {} };

    expect(findLifecycleHookLocations(config)).toEqual(["hooks"]);
  });

  it("reports an object-form generated output lifecycle-hook location", () => {
    const config = {
      generates: {
        "output/": { hooks: { beforeOneFileWrite: ["example-command"] }, preset: "example-preset" },
      },
    };

    expect(findLifecycleHookLocations(config)).toEqual(['generates["output/"].hooks']);
  });

  it("ignores array-form generated output", () => {
    const config = { generates: { "output/result.ext": ["example-plugin"] } };

    expect(findLifecycleHookLocations(config)).toEqual([]);
  });

  it("reports no lifecycle-hook locations for a hook-free configuration", () => {
    const config = { generates: { "output/": { preset: "example-preset" } } };

    expect(findLifecycleHookLocations(config)).toEqual([]);
  });
});
