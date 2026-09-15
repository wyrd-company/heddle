// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createProductionComposition } from "./composition.js";
import {
  prepareProductionFixture,
  SyntheticT3,
  type ProductionFixture,
} from "./composition.test-support.js";
import type { ResolvedSessionRuntimeMode } from "../persistence/index.js";

const execute = promisify(execFile);
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

// The lifecycle pins blueprint content from git, so an uncommitted edit is
// invisible to the running service.
const setStageRuntimeMode = async (
  fixture: ProductionFixture,
  runtimeMode: ResolvedSessionRuntimeMode,
  stageId = "implement",
): Promise<void> => {
  const path = join(
    fixture.blueprintsRepositoryRoot,
    "blueprints",
    "sample.json",
  );
  const blueprint = JSON.parse(await readFile(path, "utf8")) as {
    nodes: Array<Record<string, unknown> & { id: string }>;
  };
  blueprint.nodes.find(({ id }) => id === stageId)!["runtime-mode"] =
    runtimeMode;
  await writeFile(path, `${JSON.stringify(blueprint, null, 2)}\n`);
  await execute("git", ["add", "blueprints"], {
    cwd: fixture.blueprintsRepositoryRoot,
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
      "Set a stage runtime mode",
    ],
    { cwd: fixture.blueprintsRepositoryRoot },
  );
  await execute("git", ["push", "--quiet"], {
    cwd: fixture.blueprintsRepositoryRoot,
  });
};

const compose = (fixture: ProductionFixture, t3: SyntheticT3) =>
  createProductionComposition({
    workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
    blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
    configuration: fixture.configuration,
    providerUsage: {
      readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
    },
    pushoverTransport: { send: vi.fn(async () => undefined) },
    t3,
  });

const runtimeModesOf = (t3: SyntheticT3) =>
  t3.commands
    .filter(
      (command) =>
        command["type"] === "thread.create" ||
        command["type"] === "thread.turn.start",
    )
    .map((command) => command["runtimeMode"]);

describe("production runtime mode", () => {
  it("dispatches the configured default when no stage declares one", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    fixture.configuration.session.defaultRuntimeMode = "approval-required";
    fixture.configuration.session.defaultSelection = {
      ...fixture.configuration.session.defaultSelection,
      runtimeMode: "approval-required",
    };
    fixture.configuration.session.resolvedSelections = [
      fixture.configuration.session.defaultSelection,
    ];
    const t3 = new SyntheticT3();
    const composition = compose(fixture, t3);

    await composition.start();

    expect(runtimeModesOf(t3)).not.toEqual([]);
    expect([...new Set(runtimeModesOf(t3))]).toEqual(["approval-required"]);
    expect(
      composition.persistence
        .listSessionRuntime()
        .map(({ binding }) => binding.runtimeMode),
    ).toEqual(["approval-required"]);
    await composition.close();
  });

  it("lets the stage override the configured default at session creation", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    fixture.configuration.session.defaultRuntimeMode = "approval-required";
    fixture.configuration.session.defaultSelection = {
      ...fixture.configuration.session.defaultSelection,
      runtimeMode: "approval-required",
    };
    fixture.configuration.session.resolvedSelections = [
      fixture.configuration.session.defaultSelection,
    ];
    await setStageRuntimeMode(fixture, "full-access");
    const t3 = new SyntheticT3();
    const composition = compose(fixture, t3);

    await composition.start();

    expect([...new Set(runtimeModesOf(t3))]).toEqual(["full-access"]);
    expect(
      composition.persistence
        .listSessionRuntime()
        .map(({ binding }) => binding.runtimeMode),
    ).toEqual(["full-access"]);
    await composition.close();
  });
});
