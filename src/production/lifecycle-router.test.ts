// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupFixtures,
  makeFixture,
} from "../engine/lifecycle-engine.test-support.js";
import type { LifecycleEffect } from "../engine/index.js";
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
});
