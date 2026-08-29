import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

type PackageManifest = {
  license: string;
  name: string;
};

const readManifest = async (path: string): Promise<PackageManifest> =>
  JSON.parse(await readFile(path, "utf8")) as PackageManifest;

describe("package separation", () => {
  it("keeps production and flowcraft spike manifests distinct", async () => {
    const production = await readManifest("package.json");
    const spike = await readManifest("spikes/flowcraft-gate/package.json");

    expect(production).toMatchObject({ name: "heddle", license: "Apache-2.0" });
    expect(spike).toMatchObject({ name: "spike-flowcraft-gate" });
  });
});
