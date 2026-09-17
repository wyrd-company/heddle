import { describe, expect, it } from "vitest";

import { ExecutionEnvironmentDescriptor } from "./environment.js";

describe("ExecutionEnvironmentDescriptor", () => {
  it("decodes a realistic descriptor and preserves new capabilities", () => {
    expect(
      ExecutionEnvironmentDescriptor.parse({
        environmentId: "environment-1",
        label: "Sample environment",
        platform: { os: "linux", arch: "arm64", machine: "server" },
        serverVersion: "1.2.3",
        capabilities: { repositoryIdentity: true, futureCapability: { enabled: true } },
      }),
    ).toMatchObject({ capabilities: { futureCapability: { enabled: true } } });
  });
});
