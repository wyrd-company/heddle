// ---
// relationships:
//   verifies:
//     - blueprint-authoring
//     - engine-and-run-model
// ---
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BlueprintCatalog } from "../src/service/blueprints.js";
import { RunStore } from "../src/engine/store.js";
import { WorkflowEngine } from "../src/engine/engine.js";
import {
  commitFixture,
  fixtureGit,
  writeSample,
} from "./support/blueprint-repository.js";

const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => {
    rmSync(root, { recursive: true, force: true });
  });
});
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "blueprint-snapshot-"));
  roots.push(root);
  writeSample(root, "first");
  return root;
}
it("pins graph and artifact bytes across live repository movement and catalog restart", async () => {
  const root = fixture();
  const first = commitFixture(root);
  const catalog = new BlueprintCatalog(root);
  expect(await catalog.pin("HEAD")).toBe(first);
  const graph = await catalog.resolve(first, "sample-process");
  writeSample(root, "second");
  const second = commitFixture(root);
  writeSample(root, "uncommitted");
  for (const reader of [catalog, new BlueprintCatalog(root)]) {
    expect(await reader.resolve(first, "sample-process")).toEqual(graph);
    expect(await reader.read(first, "parcel.njk")).toBe(
      "Inspect the first parcel.\r\n",
    );
    expect(await reader.read(first, "receipt.yml")).toContain(
      "required: [first]",
    );
    expect(await reader.read(first, "routing.yml")).toContain("id: first");
    expect(await reader.read(second, "parcel.njk")).toBe(
      "Inspect the second parcel.\r\n",
    );
    expect(await reader.resolve(second, "sample-process")).not.toEqual(graph);
  }
});
it("carries the canonical commit from producer through persistence and inherited execution", async () => {
  const root = fixture();
  const first = commitFixture(root);
  const path = join(root, "runs.sqlite");
  const store = new RunStore(path);
  const catalog = new BlueprintCatalog(root);
  const engine = new WorkflowEngine(store, {
    pinCommit: async (revision) => {
      const commit = await catalog.pin(revision);
      writeSample(root, "second");
      commitFixture(root);
      return commit;
    },
    resolveBlueprint: (commit, id) => catalog.resolve(commit, id),
    nodes: {
      pass: async (context) => {
        await context.await({ kind: "pass" });
      },
    },
  });
  try {
    const run = await engine.start({
      id: "parcel",
      blueprintId: "sample-process",
      commit: "HEAD",
    });
    expect(run.commit).toBe(first);
    expect(
      run.blueprint.nodes.find((node) => node.id === "finish")?.params?.[
        "value"
      ],
    ).toBe("first-graph");
    const related = await engine.startRelated({
      id: "receipt",
      parentId: run.id,
      parentNodeId: "inspect",
      blueprintId: "sample-process",
      context: {},
    });
    expect(related.commit).toBe(first);
  } finally {
    store.close();
  }
  const restored = new RunStore(path);
  try {
    expect(restored.get("parcel").commit).toBe(first);
    expect(
      await new BlueprintCatalog(root).read(
        restored.get("receipt").commit,
        "parcel.njk",
      ),
    ).toContain("first parcel");
  } finally {
    restored.close();
  }
});
it("uses the authoring validator and safe revision and artifact diagnostics", async () => {
  const root = fixture();
  const first = commitFixture(root);
  const catalog = new BlueprintCatalog(root);
  await expect(catalog.pin("missing-revision")).rejects.toThrow(
    "missing-revision",
  );
  await expect(
    catalog.resolve("a".repeat(40), "sample-process"),
  ).rejects.toThrow("a".repeat(40));
  await expect(
    catalog.pin("https://name:credential@example.invalid/repo"),
  ).rejects.toThrow("revision <invalid identity>");
  await expect(catalog.read(first, "missing.njk")).rejects.toThrow(
    `Missing blueprint root file missing.njk at revision ${first}`,
  );
  await expect(catalog.read(first, "../outside")).rejects.toThrow(
    "Path leaves the blueprint root",
  );
  await expect(
    catalog.read(first, "/blueprint-root/parcel.njk"),
  ).rejects.toThrow("Path leaves the blueprint root");
  await expect(catalog.resolve(first, "missing-blueprint")).rejects.toThrow(
    `Unknown blueprint missing-blueprint at revision ${first}`,
  );
  rmSync(join(root, "parcel.njk"));
  const missing = commitFixture(root);
  await expect(catalog.resolve(missing, "sample-process")).rejects.toThrow(
    `parcel.njk [reference.exists]`,
  );
  writeSample(root, "third");
  writeFileSync(join(root, "receipt.yml"), "type: unknown-type\n");
  const invalid = commitFixture(root);
  await expect(catalog.resolve(invalid, "sample-process")).rejects.toThrow(
    "handoff.schema",
  );
});
it("uses structured reference identity when human wording changes", async () => {
  const root = fixture();
  const path = join(root, "sample-process.yml");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(
      "prompt: parcel.njk",
      "prompt: ../../outside/item.njk",
    ),
  );
  const commit = commitFixture(root);

  await expect(
    new BlueprintCatalog(root).resolve(commit, "sample-process"),
  ).rejects.toThrow("<invalid identity> [reference.exists] node measure");
});
it.each([
  [
    "repository location",
    (root: string) => {
      const relocated = `${root}-relocated`;
      renameSync(root, relocated);
      roots.push(relocated);
    },
  ],
  [
    "common object directory",
    (root: string) => {
      mkdirSync(join(root, ".git", "commondir"));
    },
  ],
])(
  "contains %s failures at the requested revision",
  async (_name, breakMetadata) => {
    const root = fixture();
    const first = commitFixture(root);
    const catalog = new BlueprintCatalog(root);
    expect(await catalog.pin("HEAD")).toBe(first);

    breakMetadata(root);

    await expect(
      catalog.resolve(first, "sample-process"),
    ).rejects.toMatchObject({
      message: `Cannot read blueprint tree at revision ${first}: ensure its objects and configured directory are present`,
    });
  },
);
it("reads nested catalogs and linked worktrees from packed Git objects", async () => {
  const root = mkdtempSync(join(tmpdir(), "nested-snapshot-"));
  roots.push(root);
  const nested = join(root, "recipes");
  mkdirSync(nested);
  writeSample(nested, "first");
  const first = commitFixture(root);
  fixtureGit(root, "gc");
  const linked = join(root, "linked");
  fixtureGit(root, "worktree", "add", "-b", "sample", linked, first);
  const catalog = new BlueprintCatalog(join(linked, "recipes"));
  expect(await catalog.pin("HEAD")).toBe(first);
  fixtureGit(linked, "checkout", "--detach");
  expect(await catalog.pin("HEAD")).toBe(first);
  expect(await catalog.read(first, "parcel.njk")).toContain("first parcel");
});
it("retains beside-blueprint symlinks and excludes host files", async () => {
  const root = fixture();
  writeFileSync(join(root, "actual.njk"), "A linked parcel.");
  rmSync(join(root, "parcel.njk"));
  symlinkSync("actual.njk", join(root, "parcel.njk"));
  const foreign = mkdtempSync(join(tmpdir(), "foreign-blueprint-"));
  roots.push(foreign);
  const foreignFile = join(foreign, "unrelated.yml");
  writeFileSync(foreignFile, "nodes: [invalid YAML");
  symlinkSync(foreignFile, join(root, "unrelated.yml"));
  const first = commitFixture(root);
  expect(await new BlueprintCatalog(root).read(first, "parcel.njk")).toBe(
    "A linked parcel.",
  );
  rmSync(join(root, "parcel.njk"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "outside-artifact-"));
  roots.push(outsideRoot);
  const outsidePath = join(outsideRoot, "parcel.njk");
  writeFileSync(outsidePath, "Unrelated parcel.");
  symlinkSync(outsidePath, join(root, "parcel.njk"));
  const outside = commitFixture(root);
  await expect(
    new BlueprintCatalog(root).resolve(outside, "sample-process"),
  ).rejects.toThrow("reference.exists");
});

it("keeps referenced and unreferenced symlinks inside their blueprint root", async () => {
  const root = mkdtempSync(join(tmpdir(), "artifact-boundary-"));
  roots.push(root);
  const nested = join(root, "recipes");
  mkdirSync(nested);
  writeSample(nested, "first", "recipes/");
  writeFileSync(join(root, "outer.njk"), "An unrelated parcel.");
  symlinkSync("../outer.njk", join(nested, "unreferenced.njk"));
  const first = commitFixture(root);
  const catalog = new BlueprintCatalog(root);
  // Root-relative identity: the bare spelling names nothing in this root.
  await expect(catalog.read(first, "unreferenced.njk")).rejects.toThrow(
    "Missing blueprint root file unreferenced.njk",
  );
  expect(await catalog.read(first, "recipes/unreferenced.njk")).toBe(
    "An unrelated parcel.",
  );
  expect(await catalog.read(first, "recipes/parcel.njk")).toContain(
    "first parcel",
  );
  rmSync(join(nested, "parcel.njk"));
  symlinkSync("../../outside.njk", join(nested, "parcel.njk"));
  const second = commitFixture(root);
  await expect(catalog.resolve(second, "sample-process")).rejects.toThrow(
    "reference.exists",
  );
});
