// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { ProductConfiguration } from "./configuration.js";
import { ProductBlueprintArtifactEditor } from "./product-blueprint-editor.js";

const execute = promisify(execFile);
const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratch.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const repository = async (root: string, name: string): Promise<string> => {
  const path = join(root, name);
  await mkdir(join(path, "blueprints"), { recursive: true });
  await execute("git", ["init", "--quiet"], { cwd: path });
  return path;
};

const products = (
  roots: Array<{ name: string; repositoryRoot: string }>,
): ProductConfiguration[] => [{ name: "Sample product", repos: roots }];

describe("ProductBlueprintArtifactEditor", () => {
  it("loads the one configured repository that contains the artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "heddle-product-editor-"));
    scratch.push(root);
    const alpha = await repository(root, "sample-alpha");
    const beta = await repository(root, "sample-beta");
    await writeFile(
      join(beta, "blueprints", "sample-process.json"),
      '{"nodes":[],"edges":[]}\n',
    );

    await expect(
      new ProductBlueprintArtifactEditor({
        effects: {},
        products: products([
          { name: "sample-alpha", repositoryRoot: alpha },
          { name: "sample-beta", repositoryRoot: beta },
        ]),
      }).load("sample-process"),
    ).resolves.toMatchObject({ path: "blueprints/sample-process.json" });
  });

  it("does not hide an invalid matching artifact in another repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "heddle-product-editor-"));
    scratch.push(root);
    const alpha = await repository(root, "sample-alpha");
    const beta = await repository(root, "sample-beta");
    await writeFile(
      join(alpha, "blueprints", "sample-process.json"),
      "not-json\n",
    );
    await writeFile(
      join(beta, "blueprints", "sample-process.json"),
      '{"nodes":[],"edges":[]}\n',
    );

    await expect(
      new ProductBlueprintArtifactEditor({
        effects: {},
        products: products([
          { name: "sample-alpha", repositoryRoot: alpha },
          { name: "sample-beta", repositoryRoot: beta },
        ]),
      }).load("sample-process"),
    ).rejects.toThrow("Blueprint is not valid JSON");
  });
});
