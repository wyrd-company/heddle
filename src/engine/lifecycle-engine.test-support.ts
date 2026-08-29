import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { SqlitePersistence } from "../persistence/index.js";
import { LifecycleEngine } from "./lifecycle-engine.js";
import type { LifecycleBlueprint, LifecycleEffect } from "./types.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

export const sampleBlueprint = (): LifecycleBlueprint => ({
  id: "sample-process",
  nodes: [
    { id: "mix", uses: "mix" },
    {
      id: "taste",
      uses: "wait",
      config: { joinStrategy: "any" },
    },
    {
      id: "season",
      uses: "season",
      config: { joinStrategy: "any" },
    },
    { id: "serve", uses: "serve" },
  ],
  edges: [
    { source: "mix", target: "taste" },
    {
      source: "taste",
      target: "season",
      disposition: "adjust",
      description: "Adjust the sample",
      condition: "result.output.dispositions.adjust",
    },
    {
      source: "taste",
      target: "serve",
      disposition: "accept",
      description: "Accept the sample",
      condition: "result.output.dispositions.accept",
    },
    { source: "season", target: "taste" },
  ],
});

export const conditionalTerminalBlueprint = (): LifecycleBlueprint => {
  const blueprint = sampleBlueprint();
  const acceptEdge = blueprint.edges.find(
    ({ disposition }) => disposition === "accept",
  );
  if (acceptEdge === undefined) throw new Error("accept edge is missing");
  acceptEdge.target = "choose";
  blueprint.nodes = blueprint.nodes.filter(({ id }) => id !== "serve");
  blueprint.nodes.push(
    { id: "choose", uses: "choose" },
    { id: "left", uses: "left" },
    { id: "right", uses: "right" },
  );
  blueprint.edges.push(
    {
      source: "choose",
      target: "left",
      condition: "result.output.left",
    },
    {
      source: "choose",
      target: "right",
      condition: "result.output.right",
    },
  );
  return blueprint;
};

export const makeFixture = async (
  blueprint: LifecycleBlueprint = sampleBlueprint(),
  effects?: Record<string, LifecycleEffect>,
) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "lifecycle-engine-"));
  temporaryDirectories.push(repositoryRoot);
  await execFileAsync("git", ["init", "--quiet"], { cwd: repositoryRoot });
  await mkdir(join(repositoryRoot, "blueprints"));
  const blueprintPath = "blueprints/sample.json";
  await writeFile(
    join(repositoryRoot, blueprintPath),
    JSON.stringify(blueprint),
  );
  const persistence = new SqlitePersistence({
    stateDirectory: join(repositoryRoot, "state"),
  });
  const invocations: Array<{ effect: string; idempotencyKey: string }> = [];
  const defaultEffect =
    (effect: string): LifecycleEffect =>
    async ({ idempotencyKey }) => {
      invocations.push({ effect, idempotencyKey });
      return { effect };
    };
  const engine = new LifecycleEngine({
    effects: effects ?? {
      mix: defaultEffect("mix"),
      season: defaultEffect("season"),
      serve: defaultEffect("serve"),
    },
    persistence,
    repositoryRoot,
  });
  return {
    blueprintPath,
    engine,
    invocations,
    persistence,
    repositoryRoot,
  };
};

export const cleanupFixtures = async (): Promise<void> => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
};
