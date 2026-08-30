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

import type { BoardTask } from "../board-adapter/index.js";
import type { LifecycleBlueprint } from "../engine/index.js";
import type { ProductionConfiguration } from "./configuration.js";
import { ProductLifecycleResolver } from "./product-lifecycle-resolver.js";
import { ProductRoutingCatalog } from "./product-routing.js";

const execute = promisify(execFile);
const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratch.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

const repository = async (
  root: string,
  name: string,
  requiredRepository: string,
): Promise<string> => {
  const path = join(root, name);
  await mkdir(join(path, "blueprints"), { recursive: true });
  const blueprint: LifecycleBlueprint = {
    edges: [
      {
        condition: "result.output.dispositions.complete",
        description: "Complete the sample stage.",
        disposition: "complete",
        source: "prepare",
        target: "finish",
      },
    ],
    id: "sample",
    nodes: [
      {
        handoff: "standard",
        id: "prepare",
        repo: requiredRepository,
        "todo-template": "sample-stage",
        tools: ["sample_tool"],
        uses: "wait",
      },
      { id: "finish", uses: "sample-effect" },
    ],
  };
  const artifact = { ...blueprint } as Partial<LifecycleBlueprint>;
  delete artifact.id;
  await writeFile(
    join(path, "blueprints", "sample.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  await execute("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: path,
  });
  await execute("git", ["config", "user.email", "test@example.invalid"], {
    cwd: path,
  });
  await execute("git", ["config", "user.name", "Test Operator"], { cwd: path });
  await execute("git", ["add", "."], { cwd: path });
  await execute("git", ["commit", "--quiet", "-m", "add sample blueprint"], {
    cwd: path,
  });
  return path;
};

const task = (): BoardTask => ({
  blocked: false,
  dependencies: [],
  id: 101,
  lifecycle: "sample",
  priority: "medium",
  product: "Sample product",
  repos: ["sample-alpha"],
  status: "todo",
  tags: [],
  title: "Arrange sample items",
});

describe("ProductLifecycleResolver", () => {
  it("routes an undeclared stage repository to attention before dispatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "heddle-product-lifecycle-"));
    scratch.push(root);
    const alpha = await repository(root, "sample-alpha", "sample-beta");
    const configuration = {
      products: [
        {
          name: "Sample product",
          repos: [
            { name: "sample-alpha", repositoryRoot: alpha },
            {
              name: "sample-beta",
              repositoryRoot: join(root, "sample-beta"),
            },
          ],
        },
      ],
    } as ProductionConfiguration;
    const routing = new ProductRoutingCatalog(configuration);
    const selected = task();
    routing.update([selected]);

    await expect(
      new ProductLifecycleResolver(routing).resolve(selected),
    ).resolves.toMatchObject({
      attention: { code: "stage-repository-undeclared", taskId: 101 },
      kind: "attention-required",
    });
  });
});
