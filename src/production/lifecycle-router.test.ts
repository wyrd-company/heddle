// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupFixtures,
  makeFixture,
} from "../engine/lifecycle-engine.test-support.js";
import type { LifecycleEffect } from "../engine/index.js";
import type { LifecycleBlueprint } from "../engine/index.js";
import { ProductionLifecycleRouter } from "./lifecycle-router.js";

const execute = promisify(execFile);

describe("production lifecycle router", () => {
  afterEach(cleanupFixtures);

  it("reports a transition as active only while its engine operation runs", async () => {
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: (() => void) | undefined;
    const effectEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const immediate: LifecycleEffect = async () => ({});
    const effects = {
      mix: immediate,
      season: async () => {
        entered?.();
        await barrier;
        return {};
      },
      serve: immediate,
    } satisfies Record<string, LifecycleEffect>;
    const fixture = await makeFixture(undefined, effects);
    await execute("git", ["add", "blueprints/sample.json"], {
      cwd: fixture.repositoryRoot,
    });
    await execute(
      "git",
      [
        "-c",
        "user.name=Fixture User",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Add sample",
      ],
      { cwd: fixture.repositoryRoot },
    );
    const router = new ProductionLifecycleRouter({
      effects,
      persistence: fixture.persistence,
      repositoryRoot: fixture.repositoryRoot,
      sourceRef: "HEAD",
    });
    await router.start({
      blueprintPath: fixture.blueprintPath,
      instanceId: "sample-instance",
    });

    const transition = router.resume({
      disposition: "adjust",
      instanceId: "sample-instance",
      operationId: "adjust-sample",
    });
    await effectEntered;

    expect(router.isTransitionActive("sample-instance")).toBe(true);
    release?.();
    await transition;
    expect(router.isTransitionActive("sample-instance")).toBe(false);
  });

  it("plans the reachable initial session stage instead of the first declared wait", async () => {
    const blueprint: LifecycleBlueprint = {
      id: "sample-process",
      nodes: [
        { id: "later", uses: "wait" },
        { id: "mix", uses: "mix" },
        { id: "initial", uses: "wait" },
        { id: "finish", uses: "finish" },
      ],
      edges: [
        { source: "mix", target: "initial" },
        {
          condition: "result.output.dispositions.continue",
          description: "Continue the sample",
          disposition: "continue",
          source: "initial",
          target: "later",
        },
        {
          condition: "result.output.dispositions.complete",
          description: "Complete the sample",
          disposition: "complete",
          source: "later",
          target: "finish",
        },
      ],
    };
    const effects = {
      finish: async () => ({}),
      mix: async () => ({}),
    } satisfies Record<string, LifecycleEffect>;
    const fixture = await makeFixture(blueprint, effects);
    await execute("git", ["add", "blueprints/sample.json"], {
      cwd: fixture.repositoryRoot,
    });
    await execute(
      "git",
      [
        "-c",
        "user.name=Fixture User",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Add sequential sample",
      ],
      { cwd: fixture.repositoryRoot },
    );
    const router = new ProductionLifecycleRouter({
      effects,
      persistence: fixture.persistence,
      repositoryRoot: fixture.repositoryRoot,
      sourceRef: "HEAD",
    });

    await expect(
      router.plannedStartStage({
        blueprintPath: fixture.blueprintPath,
        instanceId: "sample-instance",
      }),
    ).resolves.toBe("initial");
    expect(fixture.invocations).toEqual([]);
    expect(fixture.persistence.listInstances()).toEqual([]);
  });

  it("rejects exclusive initial session stages before the selecting effect runs", async () => {
    const blueprint: LifecycleBlueprint = {
      id: "sample-process",
      nodes: [
        { id: "choose", uses: "choose" },
        { config: { joinStrategy: "any" }, id: "left", uses: "wait" },
        { config: { joinStrategy: "any" }, id: "right", uses: "wait" },
        { id: "finish", uses: "finish" },
      ],
      edges: [
        {
          condition: "result.output.dispositions.left",
          disposition: "left",
          source: "choose",
          target: "left",
        },
        {
          condition: "result.output.dispositions.right",
          disposition: "right",
          source: "choose",
          target: "right",
        },
        {
          condition: "result.output.dispositions.complete",
          description: "Complete the left sample",
          disposition: "complete",
          source: "left",
          target: "finish",
        },
        {
          condition: "result.output.dispositions.complete",
          description: "Complete the right sample",
          disposition: "complete",
          source: "right",
          target: "finish",
        },
      ],
    };
    const choose = vi.fn<LifecycleEffect>(async () => ({
      dispositions: { right: true },
    }));
    const effects = {
      choose,
      finish: async () => ({}),
    } satisfies Record<string, LifecycleEffect>;
    const fixture = await makeFixture(blueprint, effects);
    await execute("git", ["add", "blueprints/sample.json"], {
      cwd: fixture.repositoryRoot,
    });
    await execute(
      "git",
      [
        "-c",
        "user.name=Fixture User",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Add exclusive sample",
      ],
      { cwd: fixture.repositoryRoot },
    );
    const router = new ProductionLifecycleRouter({
      effects,
      persistence: fixture.persistence,
      repositoryRoot: fixture.repositoryRoot,
      sourceRef: "HEAD",
    });

    await expect(
      router.plannedStartStage({
        blueprintPath: fixture.blueprintPath,
        instanceId: "sample-instance",
      }),
    ).rejects.toThrow("multiple possible initial session stages");
    expect(choose).not.toHaveBeenCalled();
    expect(fixture.persistence.listInstances()).toEqual([]);
  });

  it("rejects an initial route that cannot bind one session stage before effects", async () => {
    const blueprint: LifecycleBlueprint = {
      id: "sample-process",
      nodes: [
        { id: "choose", uses: "choose" },
        { config: { joinStrategy: "any" }, id: "left", uses: "wait" },
        { id: "finish", uses: "finish" },
      ],
      edges: [
        {
          condition: "result.output.dispositions.left",
          disposition: "left",
          source: "choose",
          target: "left",
        },
        {
          condition: "result.output.dispositions.right",
          disposition: "right",
          source: "choose",
          target: "finish",
        },
        {
          condition: "result.output.dispositions.complete",
          description: "Complete the left sample",
          disposition: "complete",
          source: "left",
          target: "finish",
        },
      ],
    };
    const effects = {
      choose: async () => ({ dispositions: { left: true } }),
      finish: async () => ({}),
    } satisfies Record<string, LifecycleEffect>;
    const fixture = await makeFixture(blueprint, effects);
    await execute("git", ["add", "blueprints/sample.json"], {
      cwd: fixture.repositoryRoot,
    });
    await execute(
      "git",
      [
        "-c",
        "user.name=Fixture User",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Add branching sample",
      ],
      { cwd: fixture.repositoryRoot },
    );
    const router = new ProductionLifecycleRouter({
      effects,
      persistence: fixture.persistence,
      repositoryRoot: fixture.repositoryRoot,
      sourceRef: "HEAD",
    });

    await expect(
      router.plannedStartStage({
        blueprintPath: fixture.blueprintPath,
        instanceId: "sample-instance",
      }),
    ).rejects.toThrow("mixes wait and terminal landings");
    expect(fixture.invocations).toEqual([]);
    expect(fixture.persistence.listInstances()).toEqual([]);
  });
});
