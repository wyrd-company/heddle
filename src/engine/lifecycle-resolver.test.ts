// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwd } from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import { LifecycleResolver } from "./lifecycle-resolver.js";

const temporaryDirectories: string[] = [];

const repositoryFixture = async (): Promise<string> => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "lifecycle-resolver-"));
  temporaryDirectories.push(repositoryRoot);
  return repositoryRoot;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("LifecycleResolver", () => {
  it("resolves a lifecycle property to its blueprint artifact", async () => {
    const resolver = new LifecycleResolver(cwd());

    await expect(
      resolver.resolve({
        id: 101,
        lifecycle: "standard-delivery",
        tags: ["class:expedite", "lifecycle:trivial"],
      }),
    ).resolves.toEqual({
      artifactId: "standard-delivery",
      blueprintPath: "blueprints/standard-delivery.json",
      kind: "resolved",
    });
  });

  it("uses the lifecycle tag when the property is absent", async () => {
    const resolver = new LifecycleResolver(cwd());

    await expect(
      resolver.resolve({ id: 102, tags: ["lifecycle:trivial"] }),
    ).resolves.toEqual({
      artifactId: "trivial",
      blueprintPath: "blueprints/trivial.json",
      kind: "resolved",
    });
  });

  it("raises attention when no lifecycle property or tag exists", async () => {
    const resolver = new LifecycleResolver(cwd());

    await expect(
      resolver.resolve({
        id: 103,
        tags: ["class:standard", "type:trivial"],
      }),
    ).resolves.toEqual({
      attention: {
        code: "lifecycle-not-declared",
        message: "Task 103 does not declare a lifecycle",
        taskId: 103,
      },
      kind: "attention-required",
    });
  });

  it("raises attention when the named blueprint artifact is missing", async () => {
    const repositoryRoot = await repositoryFixture();
    const resolver = new LifecycleResolver(repositoryRoot);

    await expect(
      resolver.resolve({
        id: 104,
        lifecycle: "unavailable-process",
        tags: [],
      }),
    ).resolves.toEqual({
      attention: {
        artifactId: "unavailable-process",
        code: "lifecycle-blueprint-not-found",
        message:
          "Task 104 names missing lifecycle blueprint unavailable-process",
        taskId: 104,
      },
      kind: "attention-required",
    });
  });

  it("raises attention for ambiguous or invalid lifecycle tags", async () => {
    const resolver = new LifecycleResolver(cwd());

    await expect(
      resolver.resolve({
        id: 105,
        tags: ["lifecycle:trivial", "lifecycle:standard-delivery"],
      }),
    ).resolves.toMatchObject({
      attention: {
        code: "lifecycle-declaration-invalid",
        taskId: 105,
      },
      kind: "attention-required",
    });
    await expect(
      resolver.resolve({ id: 106, lifecycle: "not_valid", tags: [] }),
    ).resolves.toMatchObject({
      attention: {
        code: "lifecycle-declaration-invalid",
        taskId: 106,
      },
      kind: "attention-required",
    });
  });
});
