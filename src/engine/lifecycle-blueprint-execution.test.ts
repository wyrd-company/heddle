// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { SqlitePersistence } from "../persistence/index.js";
import { GitBlueprintStore, LifecycleEngine } from "./index.js";
import type { LifecycleEffect } from "./types.js";

const executeFile = promisify(execFile);
const blueprintPaths = [
  "blueprints/standard-delivery.json",
  "blueprints/trivial.json",
] as const;
const temporaryDirectories: string[] = [];

const makeEngine = async (blueprintPath: (typeof blueprintPaths)[number]) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "blueprint-artifact-"));
  temporaryDirectories.push(repositoryRoot);
  await executeFile("git", ["init", "--quiet"], { cwd: repositoryRoot });
  await mkdir(join(repositoryRoot, "blueprints"));
  await copyFile(blueprintPath, join(repositoryRoot, blueprintPath));
  const persistence = new SqlitePersistence({
    stateDirectory: join(repositoryRoot, "state"),
  });
  const effectsRun: string[] = [];
  const effect =
    (name: string): LifecycleEffect =>
    async () => {
      effectsRun.push(name);
      return { name };
    };
  const engine = new LifecycleEngine({
    effects: {
      finalize: effect("finalize"),
      merge: effect("merge"),
      "prepare-worktree": effect("prepare-worktree"),
      "review-snapshot": effect("review-snapshot"),
    },
    persistence,
    repositoryRoot,
  });
  return { effectsRun, engine, persistence, repositoryRoot };
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("shipped lifecycle blueprints", () => {
  it("runs standard delivery through review remediation and retrospective", async () => {
    const fixture = await makeEngine("blueprints/standard-delivery.json");

    const implementation = await fixture.engine.start({
      blueprintPath: "blueprints/standard-delivery.json",
      instanceId: "record-a",
    });
    expect(implementation).toMatchObject({
      awaitingNodeIds: ["implement"],
      validDispositions: ["complete"],
    });
    expect(fixture.effectsRun).toEqual(["prepare-worktree"]);

    const review = await fixture.engine.resume({
      disposition: "complete",
      instanceId: "record-a",
      operationId: "operation-a",
    });
    expect(review).toMatchObject({
      awaitingNodeIds: ["review"],
      validDispositions: ["approve", "reject"],
    });
    expect(fixture.effectsRun).toEqual(["prepare-worktree", "review-snapshot"]);

    const remediation = await fixture.engine.resume({
      disposition: "reject",
      instanceId: "record-a",
      operationId: "operation-b",
    });
    expect(remediation.awaitingNodeIds).toEqual(["remediate"]);
    expect(fixture.effectsRun).toEqual(["prepare-worktree", "review-snapshot"]);

    const repeatedReview = await fixture.engine.resume({
      disposition: "complete",
      instanceId: "record-a",
      operationId: "operation-c",
    });
    expect(repeatedReview.awaitingNodeIds).toEqual(["review"]);
    expect(fixture.effectsRun).toEqual([
      "prepare-worktree",
      "review-snapshot",
      "review-snapshot",
    ]);

    const retrospective = await fixture.engine.resume({
      disposition: "approve",
      instanceId: "record-a",
      operationId: "operation-d",
    });
    expect(retrospective.awaitingNodeIds).toEqual(["retrospective"]);
    expect(fixture.effectsRun).toEqual([
      "prepare-worktree",
      "review-snapshot",
      "review-snapshot",
      "merge",
    ]);

    const completed = await fixture.engine.resume({
      disposition: "complete",
      instanceId: "record-a",
      operationId: "operation-e",
    });
    expect(completed).toMatchObject({
      awaitingNodeIds: [],
      status: "completed",
      validDispositions: [],
    });
    expect(fixture.effectsRun).toEqual([
      "prepare-worktree",
      "review-snapshot",
      "review-snapshot",
      "merge",
      "finalize",
    ]);
    fixture.persistence.close();
  });

  it("runs trivial delivery to completion without retrospective", async () => {
    const fixture = await makeEngine("blueprints/trivial.json");
    const implementation = await fixture.engine.start({
      blueprintPath: "blueprints/trivial.json",
      instanceId: "record-b",
    });
    expect(implementation.awaitingNodeIds).toEqual(["implement"]);
    expect(fixture.effectsRun).toEqual(["prepare-worktree"]);

    const review = await fixture.engine.resume({
      disposition: "complete",
      instanceId: "record-b",
      operationId: "operation-a",
    });
    expect(review.awaitingNodeIds).toEqual(["review"]);
    expect(fixture.effectsRun).toEqual(["prepare-worktree", "review-snapshot"]);

    const remediation = await fixture.engine.resume({
      disposition: "reject",
      instanceId: "record-b",
      operationId: "operation-b",
    });
    expect(remediation.awaitingNodeIds).toEqual(["remediate"]);

    const repeatedReview = await fixture.engine.resume({
      disposition: "complete",
      instanceId: "record-b",
      operationId: "operation-c",
    });
    expect(repeatedReview.awaitingNodeIds).toEqual(["review"]);
    expect(fixture.effectsRun).toEqual([
      "prepare-worktree",
      "review-snapshot",
      "review-snapshot",
    ]);

    const completed = await fixture.engine.resume({
      disposition: "approve",
      instanceId: "record-b",
      operationId: "operation-d",
    });

    expect(completed).toMatchObject({
      awaitingNodeIds: [],
      status: "completed",
    });
    expect(fixture.effectsRun).toEqual([
      "prepare-worktree",
      "review-snapshot",
      "review-snapshot",
      "merge",
      "finalize",
    ]);
    fixture.persistence.close();
  });

  it.each(blueprintPaths)(
    "derives the Flowcraft blueprint ID from %s",
    async (blueprintPath) => {
      const fixture = await makeEngine(blueprintPath);
      const pinned = await new GitBlueprintStore(fixture.repositoryRoot).pin(
        blueprintPath,
      );

      expect(pinned.blueprint.id).toBe(basename(blueprintPath, ".json"));
      expect(pinned.blueprint).not.toHaveProperty("artifactId");
      fixture.persistence.close();
    },
  );

  it("rejects an authored artifact ID at the runtime load boundary", async () => {
    const fixture = await makeEngine("blueprints/trivial.json");
    const path = join(fixture.repositoryRoot, "blueprints/trivial.json");
    const artifact = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(path, JSON.stringify({ ...artifact, id: "other" }));

    await expect(
      new GitBlueprintStore(fixture.repositoryRoot).pin(
        "blueprints/trivial.json",
      ),
    ).rejects.toThrow("ID must come from its filename");
    fixture.persistence.close();
  });

  it("rejects a blueprint filename that is not a kebab artifact ID", async () => {
    const fixture = await makeEngine("blueprints/trivial.json");
    await copyFile(
      join(fixture.repositoryRoot, "blueprints/trivial.json"),
      join(fixture.repositoryRoot, "blueprints/not_valid.json"),
    );

    await expect(
      new GitBlueprintStore(fixture.repositoryRoot).pin(
        "blueprints/not_valid.json",
      ),
    ).rejects.toThrow("filename must be a kebab ID");
    fixture.persistence.close();
  });
});
