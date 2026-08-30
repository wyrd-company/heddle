// ---
// relationships:
//   verifies: heddle
// ---

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import type { ProductionConfiguration } from "../production/index.js";
import {
  loadDeploymentConfiguration,
  resolveConfigurationDirectory,
} from "./configuration.js";

const fixture = (root: string): ProductionConfiguration => ({
  adHocProject: {
    name: "Shared records",
    projectId: "shared-project",
    workspaceRoot: join(root, "workspace"),
  },
  boardDirectory: join(root, "board"),
  cadenceMilliseconds: 1_000,
  observationThresholds: {
    endedMilliseconds: 1_000,
    failedMilliseconds: 1_000,
    stalledMilliseconds: 1_000,
  },
  pacing: {
    defaultProvider: "codex",
    maxConcurrentSessions: 1,
    providerBudgets: {},
    subagents: { maxDepth: 1, maxFanOut: 1 },
    usageWindowHours: 5,
  },
  products: [
    {
      name: "Sample collection",
      repos: [
        {
          name: "sample-repository",
          repositoryRoot: join(root, "repository"),
        },
      ],
    },
  ],
  pushover: {
    apiUrl: "https://notify.invalid/messages",
    applicationToken: "application-secret-value",
    consoleBaseUrl: "https://console.invalid/",
    userKey: "operator-secret-value",
  },
  session: {
    baseRef: "main",
    cliVersion: "1.0.0",
    driver: "codex",
    interactionMode: "default",
    model: "sample-model",
    runtimeMode: "sample-mode",
    skillPointer: "skill://sample",
  },
  stageThresholds: { inspect: 10_000 },
  stateDirectory: join(root, "state"),
  stopTimeoutMilliseconds: 1_000,
  t3: {
    accessToken: "t3-secret-value",
    baseUrl: "http://127.0.0.1:3999",
  },
});

describe("deployed configuration directory", () => {
  let root = "";

  afterEach(async () => {
    if (root !== "") await rm(root, { force: true, recursive: true });
  });

  it("resolves CLI before HEDDLE_CONFIG and otherwise uses the documented default", () => {
    expect(
      resolveConfigurationDirectory(["--config", "/tmp/cli-config"], {
        HEDDLE_CONFIG: "/tmp/environment-config",
      }),
    ).toBe("/tmp/cli-config");
    expect(
      resolveConfigurationDirectory([], {
        HEDDLE_CONFIG: "/tmp/environment-config",
      }),
    ).toBe("/tmp/environment-config");
    expect(resolveConfigurationDirectory([], {})).toBe("/home/vscode/.heddle");
  });

  it("reads only config.yml, applies server defaults, and ignores other directory entries", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    await writeFile(join(root, "config.yml"), stringify(fixture(root)));
    await writeFile(join(root, "heddle.md"), "not consumed by Task 703\n");
    await writeFile(join(root, "operator-note.txt"), "ignored\n");
    await mkdir(join(root, "blueprints"));

    await expect(loadDeploymentConfiguration(root)).resolves.toEqual({
      configuration: fixture(root),
      configurationDirectory: root,
      configurationPath: join(root, "config.yml"),
      server: { host: "127.0.0.1", port: 3774 },
    });
  });

  it("loads explicit server settings without reading deprecated HEDDLE variables", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    await writeFile(
      join(root, "config.yml"),
      stringify({
        ...fixture(root),
        server: { host: "127.0.0.2", port: 0 },
      }),
    );

    const loaded = await loadDeploymentConfiguration(root);

    expect(loaded.server).toEqual({ host: "127.0.0.2", port: 0 });
    expect(loaded.configuration.boardDirectory).toBe(join(root, "board"));
    expect(loaded.configuration.stateDirectory).toBe(join(root, "state"));
  });

  it("fails missing, unreadable, malformed, and schema-invalid config.yml with the exact path", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    const path = join(root, "config.yml");
    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      `Configuration file '${path}' is missing`,
    );

    await writeFile(path, "server: [\n");
    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      `Configuration file '${path}' is invalid YAML`,
    );

    await writeFile(path, stringify({ ...fixture(root), products: [] }));
    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      `Configuration file '${path}' is invalid: /products must NOT have fewer than 1 items`,
    );

    await rm(path);
    await mkdir(path);
    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      `Configuration file '${path}' cannot be read`,
    );
  });

  it.each([
    "t3-secret-value",
    "application-secret-value",
    "operator-secret-value",
  ])("redacts configured secret %s from validation errors", async (secret) => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    const path = join(root, "config.yml");
    const configuration = fixture(root) as ProductionConfiguration &
      Record<string, unknown>;
    configuration[secret] = true;
    await writeFile(path, stringify(configuration));

    const error = await loadDeploymentConfiguration(root).catch(
      (candidate: unknown) => candidate,
    );
    const rendered = String(error);
    expect(rendered).not.toContain(secret);
    expect(rendered).toContain("[REDACTED]");
    expect(rendered).toContain(`Configuration file '${path}' is invalid`);
  });
});
