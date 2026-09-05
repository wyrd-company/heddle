// ---
// relationships:
//   verifies: heddle
// ---

import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import type { ProductionConfiguration } from "../production/index.js";
import {
  deploymentLaunchSettings,
  loadDeploymentConfiguration,
  parseHeddleServerArguments,
  resolveConfigurationDirectory,
  validateProviderUsageConfiguration,
  validateTimeoutApplicationConfiguration,
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
    defaultProvider: "cursor",
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
    driver: "cursor",
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

const execute = promisify(execFile);

const prepareBlueprintRepository = async (root: string): Promise<string> => {
  const repositoryRoot = join(root, "blueprints");
  const remote = join(root, "blueprints-origin.git");
  await mkdir(repositoryRoot);
  await execute("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: repositoryRoot,
  });
  await writeFile(join(repositoryRoot, "README.md"), "# Sample artifacts\n");
  await execute("git", ["add", "README.md"], { cwd: repositoryRoot });
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
      "Add sample artifacts",
    ],
    { cwd: repositoryRoot },
  );
  await execute("git", ["init", "--quiet", "--bare", remote], { cwd: root });
  await execute("git", ["remote", "add", "origin", remote], {
    cwd: repositoryRoot,
  });
  await execute(
    "git",
    ["push", "--quiet", "--set-upstream", "origin", "main"],
    {
      cwd: repositoryRoot,
    },
  );
  return repositoryRoot;
};

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

  it("parses serve, nonsecret launcher, and help commands without reading config", () => {
    expect(
      parseHeddleServerArguments(
        ["--config", "/tmp/sample-config", "--print-launch-settings"],
        {},
      ),
    ).toEqual({
      command: "launch-settings",
      configurationDirectory: "/tmp/sample-config",
    });
    expect(parseHeddleServerArguments([], {})).toEqual({
      command: "serve",
      configurationDirectory: "/home/vscode/.heddle",
    });
    expect(parseHeddleServerArguments(["--help"], {})).toEqual({
      command: "help",
    });
  });

  it("keeps config.yml as configuration authority while prompt discovery stays at dispatch", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    await writeFile(join(root, "config.yml"), stringify(fixture(root)));
    await writeFile(join(root, "heddle.md"), "resolved only at dispatch\n");
    await writeFile(join(root, "operator-note.txt"), "ignored\n");
    await prepareBlueprintRepository(root);

    await expect(loadDeploymentConfiguration(root)).resolves.toEqual({
      configuration: fixture(root),
      blueprintsRepositoryRoot: join(root, "blueprints"),
      configurationDirectory: root,
      configurationPath: join(root, "config.yml"),
      server: { host: "127.0.0.1", port: 3774 },
    });
  });

  it("loads explicit server settings without reading deprecated HEDDLE variables", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    await prepareBlueprintRepository(root);
    await writeFile(
      join(root, "config.yml"),
      stringify({
        ...fixture(root),
        server: { host: "127.0.0.1", port: 4171 },
      }),
    );

    const loaded = await loadDeploymentConfiguration(root);

    expect(loaded.server).toEqual({ host: "127.0.0.1", port: 4171 });
    expect(loaded.configuration.boardDirectory).toBe(join(root, "board"));
    expect(loaded.configuration.stateDirectory).toBe(join(root, "state"));
  });

  it.each(["0.0.0.0", "::", "192.0.2.10"])(
    "rejects non-loopback server host %s at configuration load",
    async (host) => {
      root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
      await prepareBlueprintRepository(root);
      await writeFile(
        join(root, "config.yml"),
        stringify({
          ...fixture(root),
          server: { host, port: 4171 },
        }),
      );

      await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
        "/server/host must be equal to constant: 127.0.0.1",
      );
    },
  );

  it("fails closed when the derived blueprint directory is absent or not the tracked clone root", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    const configurationPath = join(root, "config.yml");
    const repositoryRoot = join(root, "blueprints");
    await writeFile(configurationPath, stringify(fixture(root)));

    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      `Blueprint repository '${repositoryRoot}' must be a git clone root whose current branch tracks origin`,
    );

    await mkdir(repositoryRoot);
    await writeFile(join(repositoryRoot, "sample.txt"), "not a clone\n");
    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      `Blueprint repository '${repositoryRoot}' must be a git clone root whose current branch tracks origin`,
    );
  });

  it("rejects a blueprint clone whose current branch tracks a remote other than origin", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    await writeFile(join(root, "config.yml"), stringify(fixture(root)));
    await prepareBlueprintRepository(root);
    await execute("git", ["remote", "rename", "origin", "other"], {
      cwd: join(root, "blueprints"),
    });

    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      `Blueprint repository '${join(root, "blueprints")}' must be a git clone root whose current branch tracks origin`,
    );
  });

  it("rejects a blueprintsRepository config field instead of creating a second root", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    await prepareBlueprintRepository(root);
    await writeFile(
      join(root, "config.yml"),
      stringify({
        ...fixture(root),
        blueprintsRepository: join(root, "other-blueprints"),
      }),
    );

    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      "/ must NOT have additional properties: blueprintsRepository",
    );
  });

  it("rejects an ephemeral port before the launcher projects Caddy settings", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    await prepareBlueprintRepository(root);
    const path = join(root, "config.yml");
    await writeFile(
      path,
      stringify({
        ...fixture(root),
        server: { host: "127.0.0.1", port: 0 },
      }),
    );

    await expect(
      execute(
        process.execPath,
        ["bin/heddle-server.mjs", "--config", root, "--print-launch-settings"],
        { env: process.env },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        `Configuration file '${path}' is invalid: /server/port must be >= 1`,
      ),
      stdout: "",
    });
  });

  it("projects only nonsecret root-launch settings", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    await prepareBlueprintRepository(root);
    await writeFile(join(root, "config.yml"), stringify(fixture(root)));

    const settings = deploymentLaunchSettings(
      await loadDeploymentConfiguration(root),
    );
    const serialized = JSON.stringify(settings);

    expect(settings).toEqual({
      host: "127.0.0.1",
      port: 3774,
      stateDirectory: join(root, "state"),
    });
    expect(serialized).not.toContain("secret-value");
    expect(Object.keys(settings).sort()).toEqual([
      "host",
      "port",
      "stateDirectory",
    ]);
  });

  it("prints the same nonsecret settings through the packaged entry point", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    await prepareBlueprintRepository(root);
    const configuration = fixture(root);
    await writeFile(join(root, "config.yml"), stringify(configuration));

    const result = await execute(
      process.execPath,
      ["bin/heddle-server.mjs", "--config", root, "--print-launch-settings"],
      {
        env: {
          ...process.env,
          HEDDLE_BOARD_PATH: "/tmp/deprecated-board",
          HEDDLE_HOST: "192.0.2.10",
          HEDDLE_PORT: "65530",
          HEDDLE_STATE_PATH: "/tmp/deprecated-state",
        },
      },
    );

    expect(JSON.parse(result.stdout)).toEqual({
      host: "127.0.0.1",
      port: 3774,
      stateDirectory: configuration.stateDirectory,
    });
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("secret-value");
    expect(result.stdout).not.toContain("deprecated");
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

  it("requires one available executable adapter exactly when provider budgets exist", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    await prepareBlueprintRepository(root);
    const path = join(root, "config.yml");
    const budgeted = fixture(root);
    budgeted.pacing.providerBudgets = { codex: { usageLimit: 80 } };
    await writeFile(path, stringify(budgeted));
    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      "providerUsage",
    );

    const executable = join(root, "provider-usage-command");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    await writeFile(
      path,
      stringify({ ...budgeted, providerUsage: { executable } }),
    );
    await expect(loadDeploymentConfiguration(root)).resolves.toMatchObject({
      providerUsage: {
        arguments: [],
        executable,
        timeoutMilliseconds: 10_000,
      },
    });

    await writeFile(
      path,
      stringify({
        ...fixture(root),
        providerUsage: { executable },
      }),
    );
    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      "must NOT be valid",
    );
  });

  it("enforces the provider-budget adapter conditional in runtime validation", () => {
    const configuration = fixture("/tmp/sample-root");
    configuration.pacing.providerBudgets = { codex: { usageLimit: 80 } };
    expect(() =>
      validateProviderUsageConfiguration(configuration, undefined),
    ).toThrow(
      "providerUsage is required when pacing.providerBudgets is non-empty",
    );

    configuration.pacing.providerBudgets = {};
    expect(() =>
      validateProviderUsageConfiguration(configuration, {
        arguments: [],
        executable: "/tmp/sample-executable",
        timeoutMilliseconds: 1_000,
      }),
    ).toThrow("providerUsage must be omitted");
  });

  it("requires a preflighted timeout application exactly for codex and claudeAgent", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    await prepareBlueprintRepository(root);
    const path = join(root, "config.yml");
    const executable = join(root, "timeout-application-command");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    const configuration = fixture(root);
    configuration.pacing.defaultProvider = "codex";
    configuration.session.driver = "codex";

    await writeFile(path, stringify(configuration));
    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      "timeoutApplication",
    );

    await writeFile(
      path,
      stringify({
        ...configuration,
        session: {
          ...configuration.session,
          timeoutApplication: { executable },
        },
      }),
    );
    const loaded = await loadDeploymentConfiguration(root);
    expect(loaded.timeoutApplication).toEqual({
      arguments: [],
      executable,
      timeoutMilliseconds: 10_000,
    });
    expect(loaded.configuration.session).not.toHaveProperty(
      "timeoutApplication",
    );

    const cursor = fixture(root);
    await writeFile(
      path,
      stringify({
        ...cursor,
        session: {
          ...cursor.session,
          timeoutApplication: { executable },
        },
      }),
    );
    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      "must NOT be valid",
    );
  });

  it("enforces the timeout-application conditional in runtime validation", () => {
    const configuration = fixture("/tmp/sample-root");
    configuration.pacing.defaultProvider = "claudeAgent";
    configuration.session.driver = "claudeAgent";
    expect(() =>
      validateTimeoutApplicationConfiguration(configuration, undefined),
    ).toThrow("session.timeoutApplication is required");

    configuration.pacing.defaultProvider = "cursor";
    configuration.session.driver = "cursor";
    expect(() =>
      validateTimeoutApplicationConfiguration(configuration, {
        arguments: [],
        executable: "/tmp/sample-executable",
        timeoutMilliseconds: 1_000,
      }),
    ).toThrow("session.timeoutApplication must be omitted");
  });

  it("fails startup preflight when the timeout application is unavailable", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    const path = join(root, "config.yml");
    const configuration = fixture(root);
    configuration.pacing.defaultProvider = "codex";
    configuration.session.driver = "codex";
    const executable = join(root, "missing-timeout-application-command");
    await writeFile(
      path,
      stringify({
        ...configuration,
        session: {
          ...configuration.session,
          timeoutApplication: { executable },
        },
      }),
    );

    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      `Configuration file '${path}' is invalid: session.timeoutApplication.executable '${executable}' must be an available executable file`,
    );
  });

  it("fails startup preflight before composition when the configured executable is unavailable", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    const path = join(root, "config.yml");
    const configuration = fixture(root);
    configuration.pacing.providerBudgets = { codex: { usageLimit: 80 } };
    const executable = join(root, "missing-provider-usage-command");
    await writeFile(
      path,
      stringify({ ...configuration, providerUsage: { executable } }),
    );

    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      `Configuration file '${path}' is invalid: providerUsage.executable '${executable}' must be an available executable file`,
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

  it("redacts actual entry-point startup failure and creates no service state", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    const path = join(root, "config.yml");
    const configuration = fixture(root) as ProductionConfiguration &
      Record<string, unknown>;
    configuration["t3-secret-value"] = true;
    await writeFile(path, stringify(configuration));

    const failure = await execute(
      process.execPath,
      ["bin/heddle-server.mjs", "--config", root],
      { env: process.env },
    ).catch((error: unknown) => error as { code: number; stderr: string });

    expect(failure).toMatchObject({ code: 1 });
    expect(failure.stderr).toContain(`Configuration file '${path}' is invalid`);
    expect(failure.stderr).toContain("[REDACTED]");
    expect(failure.stderr).not.toContain("t3-secret-value");
    expect(failure.stderr).not.toContain("application-secret-value");
    expect(failure.stderr).not.toContain("operator-secret-value");
    await expect(
      access(configuration.stateDirectory, constants.F_OK),
    ).rejects.toThrow();
  });

  it("keeps operator and Feature configuration guidance on the deployed contract", async () => {
    const [operatorGuide, featureGuide] = await Promise.all([
      readFile("docs/operators/production-composition.md", "utf8"),
      readFile(".devcontainer/features/heddle/README.md", "utf8"),
    ]);

    for (const guide of [operatorGuide, featureGuide]) {
      expect(guide).toContain("/home/vscode/.heddle");
      expect(guide).toContain("config.yml");
      expect(guide).toContain("0600");
      expect(guide).toContain("HEDDLE_CONFIG");
      expect(guide).toContain("1 through 65535");
      expect(guide).toContain("503 Service Unavailable");
    }
    expect(operatorGuide).toContain("providerUsage");
    expect(operatorGuide).toContain("session.timeoutApplication");
    expect(operatorGuide).toContain(
      "Configuration changes require service restart",
    );
    expect(featureGuide).not.toContain("`boardPath`");
    expect(featureGuide).not.toContain("`statePath`");
    expect(featureGuide).not.toContain("`port`");
  });
});
