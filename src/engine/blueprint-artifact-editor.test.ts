// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SqlitePersistence } from "../persistence/index.js";
import { BlueprintArtifactEditor } from "./blueprint-artifact-editor.js";
import { BlueprintEditConflictError } from "./errors.js";
import { GitBlueprintStore } from "./git-blueprint-store.js";
import { LifecycleEngine } from "./lifecycle-engine.js";
import type { LifecycleEffect } from "./types.js";

const executeFile = promisify(execFile);
const artifactId = "sample-process";
const artifactPath = `blueprints/${artifactId}.json`;
const temporaryDirectories: string[] = [];
const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const artifact = {
  $schema: "https://wyrd.company/heddle/lifecycle-blueprint.schema.json",
  relationships: { implements: "heddle", uses: ["sample-checklist"] },
  nodes: [
    { id: "prepare", uses: "prepare" },
    {
      id: "inspect",
      uses: "wait",
      tools: ["advance"],
      "todo-template": "sample-checklist",
    },
    { id: "finish", uses: "finish" },
  ],
  edges: [
    { source: "prepare", target: "inspect" },
    {
      source: "inspect",
      target: "finish",
      condition: "result.output.dispositions.complete",
      disposition: "complete",
      description: "Continue after inspection",
    },
  ],
};

const effect =
  (name: string, calls: string[]): LifecycleEffect =>
  async () => {
    calls.push(name);
    return { name };
  };

const fixture = async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "artifact-edit-"));
  temporaryDirectories.push(repositoryRoot);
  await executeFile("git", ["init", "--quiet"], { cwd: repositoryRoot });
  await mkdir(join(repositoryRoot, "blueprints"));
  const path = join(repositoryRoot, artifactPath);
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`);
  const calls: string[] = [];
  const effects = {
    alternate: effect("alternate", calls),
    finish: effect("finish", calls),
    prepare: effect("prepare", calls),
  };
  return {
    calls,
    editor: new BlueprintArtifactEditor({ effects, repositoryRoot }),
    effects,
    path,
    repositoryRoot,
  };
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("blueprint artifact editor", () => {
  it("binds an inspected blob hash to the artifact bytes already read", async () => {
    const setup = await fixture();
    const stable = await new GitBlueprintStore(setup.repositoryRoot).inspect(
      artifactPath,
    );
    const newer = `${stable.serialized.trimEnd()}  \n`;
    class ConcurrentInspectStore extends GitBlueprintStore {
      protected override async hashSerialized(
        serialized: string,
        path: string,
      ): Promise<string> {
        await writeFile(setup.path, newer);
        return super.hashSerialized(serialized, path);
      }
    }

    const inspected = await new ConcurrentInspectStore(
      setup.repositoryRoot,
    ).inspect(artifactPath);

    expect(inspected.serialized).toBe(stable.serialized);
    expect(inspected.blobHash).toBe(stable.blobHash);
    expect(await readFile(setup.path, "utf8")).toBe(newer);
  });

  it("round-trips canvas positions while preserving untouched node and edge bytes", async () => {
    const setup = await fixture();
    const compactNode = '{"id":"finish", "uses":"finish"}';
    const compactEdge = '{"source":"prepare", "target":"inspect"}';
    const original = await readFile(setup.path, "utf8");
    await writeFile(
      setup.path,
      original
        .replace(
          /\{\n[ ]{6}"id": "finish",\n[ ]{6}"uses": "finish"\n[ ]{4}\}/,
          compactNode,
        )
        .replace(
          /\{\n[ ]{6}"source": "prepare",\n[ ]{6}"target": "inspect"\n[ ]{4}\}/,
          compactEdge,
        ),
    );
    const loaded = await setup.editor.load(artifactId);
    const reorderedNodes = loaded.blueprint.nodes.map(
      ({ id, ...properties }) => ({ ...properties, id }),
    );
    const reorderedEdges = loaded.blueprint.edges.map(
      ({ source, target, ...properties }) => ({
        ...properties,
        source,
        target,
      }),
    );

    const saved = await setup.editor.save({
      artifactId,
      edges: reorderedEdges,
      expectedBlobHash: loaded.blobHash,
      nodes: reorderedNodes,
      positions: {
        finish: { x: 540, y: 80 },
        inspect: { x: 270, y: 180 },
        prepare: { x: 0, y: 80 },
      },
    });
    const serialized = await readFile(setup.path, "utf8");
    const reloaded = await setup.editor.load(artifactId);

    expect(serialized).toContain(compactNode);
    expect(serialized).toContain(compactEdge);
    expect(reloaded).toEqual(saved);
    expect(reloaded.positions).toEqual({
      finish: { x: 540, y: 80 },
      inspect: { x: 270, y: 180 },
      prepare: { x: 0, y: 80 },
    });
    expect(reloaded.blueprint.nodes).toEqual(loaded.blueprint.nodes);
    expect(reloaded.blueprint.edges).toEqual(loaded.blueprint.edges);
  });

  it("names a schema-invalid edit and leaves the artifact unchanged", async () => {
    const setup = await fixture();
    const loaded = await setup.editor.load(artifactId);
    const before = await readFile(setup.path);
    const invalidNodes = cloneJson(loaded.blueprint.nodes);
    invalidNodes[0]!.id = "not_valid";

    await expect(
      setup.editor.save({
        artifactId,
        edges: loaded.blueprint.edges,
        expectedBlobHash: loaded.blobHash,
        nodes: invalidNodes,
        positions: {},
      }),
    ).rejects.toThrow(/schema violation: \/nodes\/0\/id .*pattern/i);

    expect(await readFile(setup.path)).toEqual(before);
  });

  it("rejects invalid canvas positions without replacing the artifact", async () => {
    const setup = await fixture();
    const loaded = await setup.editor.load(artifactId);
    const before = await readFile(setup.path);

    await expect(
      setup.editor.save({
        artifactId,
        edges: loaded.blueprint.edges,
        expectedBlobHash: loaded.blobHash,
        nodes: loaded.blueprint.nodes,
        positions: { inspect: { x: Number.NaN, y: 80 } },
      }),
    ).rejects.toThrow(
      "Blueprint canvas positions must use kebab node IDs and finite coordinates",
    );

    expect(await readFile(setup.path)).toEqual(before);
  });

  it("rejects artifact IDs that could escape the blueprint directory", async () => {
    const setup = await fixture();
    const before = await readFile(setup.path);

    await expect(setup.editor.load("../sample-process")).rejects.toThrow(
      "Blueprint artifact ID must be a kebab ID",
    );

    expect(await readFile(setup.path)).toEqual(before);
  });

  it("applies the interpreter contract before replacing the artifact", async () => {
    const setup = await fixture();
    const loaded = await setup.editor.load(artifactId);
    const before = await readFile(setup.path);

    await expect(
      setup.editor.save({
        artifactId,
        edges: [],
        expectedBlobHash: loaded.blobHash,
        nodes: loaded.blueprint.nodes,
        positions: {},
      }),
    ).rejects.toThrow(/Wait node "inspect" has no disposition edges/);

    expect(await readFile(setup.path)).toEqual(before);
  });

  it("rejects a stale edit without replacing the newer artifact", async () => {
    const setup = await fixture();
    const loaded = await setup.editor.load(artifactId);
    const newer = `${(await readFile(setup.path, "utf8")).trimEnd()}  \n`;
    await writeFile(setup.path, newer);

    await expect(
      setup.editor.save({
        artifactId,
        edges: loaded.blueprint.edges,
        expectedBlobHash: loaded.blobHash,
        nodes: loaded.blueprint.nodes,
        positions: {},
      }),
    ).rejects.toBeInstanceOf(BlueprintEditConflictError);

    expect(await readFile(setup.path, "utf8")).toBe(newer);
  });

  it("rejects an artifact change made during replacement", async () => {
    const setup = await fixture();
    const loaded = await setup.editor.load(artifactId);
    const newer = `${(await readFile(setup.path, "utf8")).trimEnd()}  \n`;
    const inspect = GitBlueprintStore.prototype.inspect;
    let inspections = 0;
    vi.spyOn(GitBlueprintStore.prototype, "inspect").mockImplementation(
      async function (path) {
        inspections += 1;
        if (inspections === 3) await writeFile(setup.path, newer);
        return inspect.call(this, path);
      },
    );

    await expect(
      setup.editor.save({
        artifactId,
        edges: loaded.blueprint.edges,
        expectedBlobHash: loaded.blobHash,
        nodes: loaded.blueprint.nodes,
        positions: {},
      }),
    ).rejects.toBeInstanceOf(BlueprintEditConflictError);

    expect(await readFile(setup.path, "utf8")).toBe(newer);
  });

  it("rejects an invalid expected blob hash without replacing the artifact", async () => {
    const setup = await fixture();
    const loaded = await setup.editor.load(artifactId);
    const before = await readFile(setup.path);

    await expect(
      setup.editor.save({
        artifactId,
        edges: loaded.blueprint.edges,
        expectedBlobHash: "not-a-git-object-id",
        nodes: loaded.blueprint.nodes,
        positions: {},
      }),
    ).rejects.toThrow("Expected blueprint git blob hash is invalid");

    expect(await readFile(setup.path)).toEqual(before);
  });

  it("keeps a running instance on its pinned blob after a saved edit", async () => {
    const setup = await fixture();
    const persistence = new SqlitePersistence({
      stateDirectory: join(setup.repositoryRoot, "state"),
    });
    const engine = new LifecycleEngine({
      effects: setup.effects,
      persistence,
      repositoryRoot: setup.repositoryRoot,
    });
    const started = await engine.start({
      blueprintPath: artifactPath,
      instanceId: "record-a",
    });
    const loaded = await setup.editor.load(artifactId);
    const editedNodes = cloneJson(loaded.blueprint.nodes);
    const finish = editedNodes.find(({ id }) => id === "finish");
    if (finish === undefined) throw new Error("fixture finish node is absent");
    finish.uses = "alternate";

    const saved = await setup.editor.save({
      artifactId,
      edges: loaded.blueprint.edges,
      expectedBlobHash: loaded.blobHash,
      nodes: editedNodes,
      positions: {},
    });
    await engine.resume({
      disposition: "complete",
      instanceId: "record-a",
      operationId: "operation-a",
    });
    const pinned = await new GitBlueprintStore(setup.repositoryRoot).read(
      started.blueprintBlobHash,
      artifactPath,
    );

    expect(saved.blobHash).not.toBe(started.blueprintBlobHash);
    expect(pinned.nodes.find(({ id }) => id === "finish")?.uses).toBe("finish");
    expect(setup.calls).toEqual(["prepare", "finish"]);
    persistence.close();
  });
});
