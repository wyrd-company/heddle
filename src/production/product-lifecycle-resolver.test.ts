// ---
// relationships:
//   verifies: heddle
// ---

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BoardTask } from "../board-adapter/index.js";
import type { ProductionConfiguration } from "./configuration.js";
import {
  executeGit,
  prepareBlueprintRepositoryFixture,
  type BlueprintRepositoryFixture,
} from "./blueprint-repository.test-support.js";
import { ProductLifecycleResolver } from "./product-lifecycle-resolver.js";
import { ProductRoutingCatalog } from "./product-routing.js";

const task = (): BoardTask => ({
  blocked: false,
  dependencies: [],
  id: 101,
  lifecycle: "sample-process",
  priority: "medium",
  product: "Sample collection",
  repos: ["sample-alpha"],
  status: "todo",
  tags: [],
  title: "Arrange sample items",
});

describe("ProductLifecycleResolver", () => {
  let fixture: BlueprintRepositoryFixture | undefined;

  afterEach(async () => {
    await fixture?.cleanup();
    fixture = undefined;
  });

  const prepare = async (requiredRepository: string) => {
    fixture = await prepareBlueprintRepositoryFixture();
    const artifactPath = join(
      fixture.repositoryRoot,
      "blueprints",
      "sample-process.json",
    );
    const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as {
      nodes: Array<Record<string, unknown>>;
    };
    artifact.nodes.find(({ uses }) => uses === "wait")!.repo =
      requiredRepository;
    await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
    await executeGit("git", ["add", "blueprints/sample-process.json"], {
      cwd: fixture.repositoryRoot,
    });
    await executeGit("git", ["commit", "--quiet", "-m", "Route sample stage"], {
      cwd: fixture.repositoryRoot,
    });
    await executeGit("git", ["push", "--quiet"], {
      cwd: fixture.repositoryRoot,
    });
    const alpha = join(fixture.root, "sample-alpha");
    const beta = join(fixture.root, "sample-beta");
    await mkdir(join(alpha, "blueprints"), { recursive: true });
    await mkdir(beta);
    const configuration = {
      products: [
        {
          name: "Sample collection",
          repos: [
            { name: "sample-alpha", repositoryRoot: alpha },
            { name: "sample-beta", repositoryRoot: beta },
          ],
        },
      ],
    } as ProductionConfiguration;
    const routing = new ProductRoutingCatalog(configuration);
    const selected = task();
    routing.update([selected]);
    return {
      alpha,
      resolver: new ProductLifecycleResolver(routing, fixture.repository),
      selected,
    };
  };

  it("routes an undeclared stage repository to attention before dispatch", async () => {
    const { resolver, selected } = await prepare("sample-beta");

    await expect(resolver.resolve(selected)).resolves.toMatchObject({
      attention: { code: "stage-repository-undeclared", taskId: 101 },
      kind: "attention-required",
    });
  });

  it("resolves only the central blueprint root even when a product repository carries a conflicting artifact", async () => {
    const { alpha, resolver, selected } = await prepare("sample-alpha");
    await writeFile(
      join(alpha, "blueprints", "sample-process.json"),
      "not valid json\n",
    );

    await expect(resolver.resolve(selected)).resolves.toEqual({
      artifactId: "sample-process",
      blueprintPath: "blueprints/sample-process.json",
      kind: "resolved",
    });
  });
});
