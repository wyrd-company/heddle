import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

type PackageManifest = {
  bin?: Record<string, string>;
  dependencies: Record<string, string>;
  license: string;
  name: string;
};

type PackageLock = {
  packages: Record<string, PackageManifest>;
};

const readManifest = async (path: string): Promise<PackageManifest> =>
  JSON.parse(await readFile(path, "utf8")) as PackageManifest;

describe("package separation", () => {
  it("keeps production and flowcraft spike manifests distinct", async () => {
    const production = await readManifest("package.json");
    const spike = await readManifest("spikes/flowcraft-gate/package.json");
    const lock = JSON.parse(
      await readFile("package-lock.json", "utf8"),
    ) as PackageLock;

    expect(production).toMatchObject({ name: "heddle", license: "Apache-2.0" });
    expect(lock.packages[""]).toMatchObject({
      dependencies: { flowcraft: "2.10.1" },
      name: production.name,
      license: production.license,
    });
    expect(production.dependencies).toMatchObject({ flowcraft: "2.10.1" });
    expect(spike).toMatchObject({ name: "spike-flowcraft-gate" });
  });

  it("documents the relocated spike working directory", async () => {
    const spikeDocument = await readFile(
      "docs/spikes/flowcraft-gate.md",
      "utf8",
    );

    expect(spikeDocument).toContain(
      "Working directory for every relative path and reproduction command:\n" +
        "`spikes/flowcraft-gate` from the repository root.",
    );
  });

  it("packages the maintained Cursor API-key wrapper", async () => {
    const production = await readManifest("package.json");

    expect(production.bin).toMatchObject({
      "heddle-cursor-agent": "bin/heddle-cursor-agent.mjs",
      "heddle-server": "bin/heddle-server.mjs",
    });
    await expect(
      readFile("bin/heddle-cursor-agent.mjs", "utf8"),
    ).resolves.toContain("cursor-acp-authenticate-shim.mjs");
  });
});
