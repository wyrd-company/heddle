// ---
// relationships:
//   verifies: heddle
// ---

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BoardTask } from "../board-adapter/index.js";
import {
  executeGit,
  prepareBlueprintRepositoryFixture,
  type BlueprintRepositoryFixture,
} from "./blueprint-repository.test-support.js";
import { TaskRepositoryRouter } from "./repository-routing.js";
import { TaskLifecycleResolver } from "./task-lifecycle-resolver.js";

const task = (): BoardTask => ({
  blocked: false,
  dependencies: [],
  frontMatter: { repos: ["sample-alpha"] },
  id: 101,
  lifecycle: "sample-process",
  priority: "medium",
  repos: ["sample-alpha"],
  status: "todo",
  tags: [],
  title: "Arrange sample items",
});

describe("TaskLifecycleResolver", () => {
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
    const toolsRoot = join(fixture.root, "tools");
    const alpha = join(toolsRoot, "sample-alpha");
    await mkdir(join(alpha, "blueprints"), { recursive: true });
    await mkdir(join(toolsRoot, "sample-beta"));
    const routing = new TaskRepositoryRouter(fixture.root);
    const selected = task();
    routing.update([selected]);
    return {
      alpha,
      resolver: new TaskLifecycleResolver(routing, fixture.repository),
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

  it("resolves only the central blueprint root when a task repository carries a conflicting artifact", async () => {
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
