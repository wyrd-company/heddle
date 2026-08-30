// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers";
import { promisify } from "node:util";

import Database from "better-sqlite3";
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
      handoff: "standard",
      "handoff-template": {
        blobHash: "a".repeat(40),
        path: "handoff-templates/sample.md",
      },
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

  it("rejects an external artifact change at the pre-rename boundary", async () => {
    const setup = await fixture();
    const loaded = await setup.editor.load(artifactId);
    const newer = `${(await readFile(setup.path, "utf8")).trimEnd()}  \n`;
    class ExternalWriterStore extends GitBlueprintStore {
      protected override async beforeArtifactRename(): Promise<void> {
        await writeFile(setup.path, newer);
      }
    }
    const store = new ExternalWriterStore(setup.repositoryRoot);
    const replacement = `${newer.trimEnd()} \n`;

    await expect(
      store.replace(artifactPath, loaded.blobHash, replacement),
    ).rejects.toBeInstanceOf(BlueprintEditConflictError);

    expect(await readFile(setup.path, "utf8")).toBe(newer);
  });

  it("serializes repository writers through the comparison and rename", async () => {
    const setup = await fixture();
    const loaded = await new GitBlueprintStore(setup.repositoryRoot).inspect(
      artifactPath,
    );
    let enterBoundary!: () => void;
    let releaseBoundary!: () => void;
    const boundaryEntered = new Promise<void>((resolveBoundary) => {
      enterBoundary = resolveBoundary;
    });
    const boundaryReleased = new Promise<void>((resolveBoundary) => {
      releaseBoundary = resolveBoundary;
    });
    class PausedWriterStore extends GitBlueprintStore {
      protected override async beforeArtifactRename(): Promise<void> {
        enterBoundary();
        await boundaryReleased;
      }
    }
    let enterSecondBoundary!: () => void;
    const secondBoundaryEntered = new Promise<void>((resolveBoundary) => {
      enterSecondBoundary = resolveBoundary;
    });
    class ObservedWriterStore extends GitBlueprintStore {
      protected override async beforeArtifactRename(): Promise<void> {
        enterSecondBoundary();
      }
    }
    const firstBytes = `${loaded.serialized.trimEnd()} \n`;
    const secondBytes = `${loaded.serialized.trimEnd()}  \n`;
    const first = new PausedWriterStore(setup.repositoryRoot).replace(
      artifactPath,
      loaded.blobHash,
      firstBytes,
    );
    await boundaryEntered;
    let secondSettled = false;
    const second = new ObservedWriterStore(setup.repositoryRoot)
      .replace(artifactPath, loaded.blobHash, secondBytes)
      .finally(() => {
        secondSettled = true;
      });
    const crossedBoundary = await Promise.race([
      secondBoundaryEntered.then(() => true),
      new Promise<false>((resolveWait) =>
        setTimeout(() => resolveWait(false), 75),
      ),
    ]);

    const settledBeforeRelease = secondSettled;
    releaseBoundary();
    const [firstResult, secondResult] = await Promise.allSettled([
      first,
      second,
    ]);

    expect({
      crossedBoundary,
      firstStatus: firstResult.status,
      secondConflict:
        secondResult.status === "rejected" &&
        secondResult.reason instanceof BlueprintEditConflictError,
      settledBeforeRelease,
    }).toEqual({
      crossedBoundary: false,
      firstStatus: "fulfilled",
      secondConflict: true,
      settledBeforeRelease: false,
    });
    expect(await readFile(setup.path, "utf8")).toBe(firstBytes);
  });

  it("rejects a blueprint directory symlink without reading outside the repository", async () => {
    const setup = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "artifact-outside-"));
    temporaryDirectories.push(outside);
    const outsideArtifact = join(outside, `${artifactId}.json`);
    const outsideBytes = `${JSON.stringify(artifact)}\n`;
    await writeFile(outsideArtifact, outsideBytes);
    await rm(join(setup.repositoryRoot, "blueprints"), {
      recursive: true,
    });
    await symlink(outside, join(setup.repositoryRoot, "blueprints"), "dir");

    await expect(
      new GitBlueprintStore(setup.repositoryRoot).inspect(artifactPath),
    ).rejects.toThrow(
      "Blueprint artifact must be a physical regular file inside the repository blueprint directory",
    );
    await expect(
      new GitBlueprintStore(setup.repositoryRoot).pin(artifactPath),
    ).rejects.toThrow(
      "Blueprint artifact must be a physical regular file inside the repository blueprint directory",
    );
    expect(await readFile(outsideArtifact, "utf8")).toBe(outsideBytes);
  });

  it("rejects a blueprint file symlink without replacing its external target", async () => {
    const setup = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "artifact-outside-"));
    temporaryDirectories.push(outside);
    const outsideArtifact = join(outside, `${artifactId}.json`);
    const outsideBytes = `${JSON.stringify(artifact)}\n`;
    await writeFile(outsideArtifact, outsideBytes);
    await rm(setup.path);
    await symlink(outsideArtifact, setup.path, "file");

    await expect(
      new GitBlueprintStore(setup.repositoryRoot).replace(
        artifactPath,
        "a".repeat(40),
        "replacement",
      ),
    ).rejects.toThrow(
      "Blueprint artifact must be a physical regular file inside the repository blueprint directory",
    );
    expect(await readFile(outsideArtifact, "utf8")).toBe(outsideBytes);
  });

  it("rejects a blueprint component swap at the pre-rename boundary", async () => {
    const setup = await fixture();
    const loaded = await new GitBlueprintStore(setup.repositoryRoot).inspect(
      artifactPath,
    );
    const outside = await mkdtemp(join(tmpdir(), "artifact-outside-"));
    temporaryDirectories.push(outside);
    const outsideArtifact = join(outside, `${artifactId}.json`);
    const outsideBytes = `${JSON.stringify(artifact)}\n`;
    await writeFile(outsideArtifact, outsideBytes);
    class DirectorySwapStore extends GitBlueprintStore {
      protected override async beforeArtifactRename(): Promise<void> {
        await rename(
          join(setup.repositoryRoot, "blueprints"),
          join(setup.repositoryRoot, "relocated-blueprints"),
        );
        await symlink(outside, join(setup.repositoryRoot, "blueprints"), "dir");
      }
    }

    await expect(
      new DirectorySwapStore(setup.repositoryRoot).replace(
        artifactPath,
        loaded.blobHash,
        `${loaded.serialized.trimEnd()} \n`,
      ),
    ).rejects.toThrow(
      "Blueprint artifact must be a physical regular file inside the repository blueprint directory",
    );
    expect(await readFile(outsideArtifact, "utf8")).toBe(outsideBytes);
    expect(
      await readFile(
        join(
          setup.repositoryRoot,
          "relocated-blueprints",
          `${artifactId}.json`,
        ),
        "utf8",
      ),
    ).toBe(loaded.serialized);
  });

  it("recovers a stale repository writer lease before replacing", async () => {
    const setup = await fixture();
    const store = new GitBlueprintStore(setup.repositoryRoot);
    const loaded = await store.inspect(artifactPath);
    const { stdout } = await executeFile(
      "git",
      [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "heddle/blueprint-writer-lease.sqlite",
      ],
      { cwd: setup.repositoryRoot },
    );
    const leasePath = stdout.trim();
    await mkdir(dirname(leasePath), { recursive: true });
    const leaseDatabase = new Database(leasePath);
    leaseDatabase.exec(`
      CREATE TABLE blueprint_writer_lease (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        token TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    leaseDatabase
      .prepare(
        "INSERT INTO blueprint_writer_lease (singleton, token, expires_at) VALUES (1, ?, ?)",
      )
      .run("crashed-writer", Date.now() - 60_000);
    leaseDatabase.close();
    const replacement = `${loaded.serialized.trimEnd()} \n`;

    await store.replace(artifactPath, loaded.blobHash, replacement);

    expect(await readFile(setup.path, "utf8")).toBe(replacement);
    const recoveredDatabase = new Database(leasePath, { readonly: true });
    expect(
      recoveredDatabase
        .prepare("SELECT COUNT(*) AS count FROM blueprint_writer_lease")
        .get(),
    ).toEqual({ count: 0 });
    recoveredDatabase.close();
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
