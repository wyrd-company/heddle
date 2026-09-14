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
  symlink,
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
  effectiveConfigurationDisclosure,
  loadDeploymentConfiguration,
  parseHeddleServerArguments,
  resolveConfigurationDirectory,
  validateProviderUsageConfiguration,
} from "./configuration.js";

const fixture = (root: string): ProductionConfiguration => ({
  adHocProject: {
    name: "Shared records",
    projectId: "shared-project",
    workspaceRoot: join(root, "workspace"),
  },
  boardDirectory: join(root, "board"),
  cadenceMilliseconds: 1_000,
  incident: {
    approvalSeverityThreshold: "high",
    failureThreshold: 3,
    githubIssueRepository: "sample-owner/sample-repository",
    immediateEscalationCodes: [],
    retryDelayMilliseconds: 60_000,
    workspaceRoot: root,
  },
  observationThresholds: {
    endedMilliseconds: 1_000,
    failedMilliseconds: 1_000,
    stalledMilliseconds: 1_000,
  },
  pacing: {
    maxConcurrentSessions: 1,
    providerBudgets: {},
    subagents: { maxDepth: 1, maxFanOut: 1 },
    usageWindowHours: 5,
  },
  providerAliases: {
    primary: {
      model: "sample-model",
      providerDisplayName: "Workbench Alpha",
    },
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
    defaultProviderAlias: "primary",
    defaultRuntimeMode: "auto",
    interactionMode: "default",
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
    expect(
      parseHeddleServerArguments(
        ["--print-effective-configuration", "--config", "/tmp/sample-config"],
        {},
      ),
    ).toEqual({
      command: "effective-configuration",
      configurationDirectory: "/tmp/sample-config",
    });
    expect(parseHeddleServerArguments(["--help"], {})).toEqual({
      command: "help",
    });
    expect(() =>
      parseHeddleServerArguments(
        ["--print-launch-settings", "--print-effective-configuration"],
        {},
      ),
    ).toThrow("Choose one configuration diagnostic output");
  });

  it("keeps configuration bundle loading separate from prompt discovery", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    await writeFile(join(root, "config.yml"), stringify(fixture(root)));
    await writeFile(join(root, "heddle.md"), "resolved only at dispatch\n");
    await writeFile(join(root, "operator-note.txt"), "ignored\n");
    await prepareBlueprintRepository(root);

    await expect(loadDeploymentConfiguration(root)).resolves.toMatchObject({
      configuration: fixture(root),
      blueprintsRepositoryRoot: join(root, "blueprints"),
      configurationDirectory: root,
      configurationPath: join(root, "config.yml"),
      server: { host: "127.0.0.1", port: 3774 },
    });
  });

  it("layers shared core and an optional worker source without changing mounted inputs", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-layered-config-"));
    const shared = join(root, "shared");
    const workerA = join(root, "worker-a");
    const workerB = join(root, "worker-b");
    await mkdir(shared);
    await Promise.all([mkdir(workerA), mkdir(workerB)]);
    await prepareBlueprintRepository(shared);

    const executable = join(shared, "provider-usage-command");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    const core = fixture(shared);
    core.adjudication = {
      policyPath: "adjudication/policy.json",
      providerAlias: "primary",
    };
    core.pacing.providerBudgets = { primary: { usageLimit: 80 } };
    core.providerAliases.primary = [
      {
        model: "sample-model-a",
        providerDisplayName: "Workbench Alpha",
      },
      {
        model: "sample-model-b",
        providerDisplayName: "Workbench Beta",
      },
    ];
    const coreSource = stringify({
      ...core,
      providerUsage: { executable },
    });
    const sharedCorePath = join(shared, "config.yml");
    await writeFile(sharedCorePath, coreSource);
    await chmod(sharedCorePath, 0o444);

    for (const worker of [workerA, workerB]) {
      await symlink(sharedCorePath, join(worker, "config.yml"));
      await symlink(join(shared, "blueprints"), join(worker, "blueprints"));
    }
    const workerAPath = join(workerA, "worker.yml");
    const workerASource = stringify({
      adjudication: null,
      boardDirectory: join(root, "board-a"),
      pacing: { providerBudgets: null },
      providerAliases: {
        primary: [
          {
            model: "sample-model-b",
            providerDisplayName: "Workbench Beta",
          },
          {
            model: "sample-model-a",
            providerDisplayName: "Workbench Alpha",
          },
        ],
      },
      providerUsage: null,
      stateDirectory: join(root, "state-a"),
      t3: {
        accessToken: "worker-a-t3-secret",
        baseUrl: "http://127.0.0.1:4101",
      },
    });
    await writeFile(workerAPath, workerASource);
    await chmod(workerAPath, 0o444);

    const [loadedA, loadedB] = await Promise.all([
      loadDeploymentConfiguration(workerA),
      loadDeploymentConfiguration(workerB),
    ]);

    expect(loadedA.configuration.boardDirectory).toBe(join(root, "board-a"));
    expect(loadedA.configuration.stateDirectory).toBe(join(root, "state-a"));
    expect(loadedA.configuration.t3.baseUrl).toBe("http://127.0.0.1:4101");
    expect(loadedA.configuration.adjudication).toBeUndefined();
    expect(loadedA.configuration.pacing.providerBudgets).toEqual({});
    expect(loadedA.providerUsage).toBeUndefined();
    expect(loadedA.configuration.providerAliases.primary).toEqual([
      {
        model: "sample-model-b",
        providerDisplayName: "Workbench Beta",
      },
      {
        model: "sample-model-a",
        providerDisplayName: "Workbench Alpha",
      },
    ]);
    expect(loadedA.configurationProvenance).toMatchObject({
      "/boardDirectory": workerAPath,
      "/pacing/providerBudgets": "built-in",
      "/server/port": "built-in",
      "/t3/accessToken": workerAPath,
    });
    expect(loadedA.configurationClearedBy).toMatchObject({
      "/adjudication": workerAPath,
      "/pacing/providerBudgets": workerAPath,
      "/providerUsage": workerAPath,
    });

    expect(loadedB.workerConfigurationPath).toBeUndefined();
    expect(loadedB.configuration.boardDirectory).toBe(join(shared, "board"));
    expect(
      loadedB.configuration.adjudication?.approvalSettlementMilliseconds,
    ).toBe(60_000);
    expect(loadedB.configuration.stateDirectory).toBe(join(shared, "state"));
    expect(loadedB.configuration.t3.baseUrl).toBe("http://127.0.0.1:3999");
    expect(loadedB.configuration.pacing.providerBudgets).toEqual({
      primary: { usageLimit: 80 },
    });
    expect(loadedB.providerUsage?.executable).toBe(executable);
    expect(
      loadedB.configurationProvenance?.[
        "/adjudication/approvalSettlementMilliseconds"
      ],
    ).toBe("built-in");
    expect(loadedB.configuration.session.worktreesRoot).toBe(
      "/workspaces/worktrees",
    );
    expect(await readFile(sharedCorePath, "utf8")).toBe(coreSource);
    expect(await readFile(workerAPath, "utf8")).toBe(workerASource);
    const { stdout: blueprintStatus } = await execute(
      "git",
      ["status", "--porcelain"],
      { cwd: join(shared, "blueprints") },
    );
    expect(blueprintStatus).toBe("");
  });

  it("names the worker source and field when an override is invalid", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-layered-config-"));
    await prepareBlueprintRepository(root);
    await writeFile(join(root, "config.yml"), stringify(fixture(root)));
    const workerPath = join(root, "worker.yml");
    await writeFile(workerPath, stringify({ boardDirectory: "relative" }));

    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      `field '/boardDirectory' from '${workerPath}'`,
    );

    await writeFile(workerPath, "boardDirectory: [\n");
    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      `Configuration file '${workerPath}' is invalid YAML`,
    );
  });

  it("prints redacted effective values, provenance, and explicit clears", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-layered-config-"));
    await prepareBlueprintRepository(root);
    const core = fixture(root);
    core.incident.immediateEscalationCodes = ["t3-secret-value"];
    await writeFile(join(root, "config.yml"), stringify(core));
    const workerPath = join(root, "worker.yml");
    await writeFile(
      workerPath,
      stringify({
        boardDirectory: join(root, "worker-board"),
        incident: {
          immediateEscalationCodes: ["t3-secret-value", "worker-t3-secret"],
        },
        stageThresholds: { "worker-t3-secret": 20_000 },
        t3: { accessToken: "worker-t3-secret" },
      }),
    );

    const disclosure = effectiveConfigurationDisclosure(
      await loadDeploymentConfiguration(root),
    );
    const serialized = JSON.stringify(disclosure);

    expect(disclosure.sources).toEqual({
      builtIn: "built-in",
      core: join(root, "config.yml"),
      worker: workerPath,
    });
    expect(disclosure.provenance).toMatchObject({
      "/boardDirectory": workerPath,
      "/server/host": "built-in",
      "/t3/baseUrl": join(root, "config.yml"),
    });
    expect(disclosure.configuration).toMatchObject({
      boardDirectory: join(root, "worker-board"),
      incident: {
        immediateEscalationCodes: ["[REDACTED]", "[REDACTED]"],
      },
      server: { host: "127.0.0.1", port: 3774 },
      stageThresholds: { "[REDACTED]": 20_000 },
      t3: { accessToken: "[REDACTED]" },
    });
    expect(disclosure.provenance["/stageThresholds/[REDACTED]"]).toBe(
      workerPath,
    );
    expect(serialized).not.toContain("worker-t3-secret");
    expect(serialized).not.toContain("application-secret-value");
    expect(serialized).not.toContain("operator-secret-value");
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

  it("rejects the removed session launch-preparation configuration", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    await prepareBlueprintRepository(root);
    const configuration = fixture(root) as ProductionConfiguration & {
      session: Record<string, unknown>;
    };
    configuration.session["launchPreparation"] = {
      sample: { executable: "/tmp/sample-launch-preparation" },
    };
    await writeFile(join(root, "config.yml"), stringify(configuration));

    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      "/session must NOT have additional properties: launchPreparation",
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
        `field '/server/port' from '${path}': /server/port must be >= 1`,
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

  it("prints the redacted layered configuration through the packaged entry point", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    await prepareBlueprintRepository(root);
    await writeFile(join(root, "config.yml"), stringify(fixture(root)));
    const workerPath = join(root, "worker.yml");
    await writeFile(
      workerPath,
      stringify({ boardDirectory: join(root, "worker-board") }),
    );

    const result = await execute(
      process.execPath,
      [
        "bin/heddle-server.mjs",
        "--config",
        root,
        "--print-effective-configuration",
      ],
      { env: process.env },
    );
    const disclosure = JSON.parse(result.stdout) as {
      configuration: Record<string, unknown>;
      provenance: Record<string, string>;
      sources: Record<string, string>;
    };

    expect(disclosure.sources["worker"]).toBe(workerPath);
    expect(disclosure.provenance["/boardDirectory"]).toBe(workerPath);
    expect(disclosure.configuration["boardDirectory"]).toBe(
      join(root, "worker-board"),
    );
    expect(result.stdout).not.toContain("secret-value");
    expect(result.stderr).toBe("");
  });

  it("reloads worker overrides when the packaged process restarts", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    await prepareBlueprintRepository(root);
    await writeFile(join(root, "config.yml"), stringify(fixture(root)));
    const workerPath = join(root, "worker.yml");
    const printEffective = () =>
      execute(
        process.execPath,
        [
          "bin/heddle-server.mjs",
          "--config",
          root,
          "--print-effective-configuration",
        ],
        { env: process.env },
      );

    await writeFile(
      workerPath,
      stringify({ boardDirectory: join(root, "board-before-restart") }),
    );
    const before = JSON.parse((await printEffective()).stdout) as {
      configuration: { boardDirectory: string };
    };
    await writeFile(
      workerPath,
      stringify({ boardDirectory: join(root, "board-after-restart") }),
    );
    const after = JSON.parse((await printEffective()).stdout) as {
      configuration: { boardDirectory: string };
    };

    expect(before.configuration.boardDirectory).toBe(
      join(root, "board-before-restart"),
    );
    expect(after.configuration.boardDirectory).toBe(
      join(root, "board-after-restart"),
    );
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

    const withoutBoardDirectory: Record<string, unknown> = { ...fixture(root) };
    delete withoutBoardDirectory["boardDirectory"];
    await writeFile(path, stringify(withoutBoardDirectory));
    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      `field '/boardDirectory' from '${path}'`,
    );

    await writeFile(path, stringify({ ...fixture(root), products: [] }));
    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      `field '/products' from '${path}': /products must NOT have fewer than 1 items`,
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
    budgeted.pacing.providerBudgets = { primary: { usageLimit: 80 } };
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

  it("fails startup preflight before composition when the configured executable is unavailable", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    const path = join(root, "config.yml");
    const configuration = fixture(root);
    configuration.pacing.providerBudgets = { primary: { usageLimit: 80 } };
    const executable = join(root, "missing-provider-usage-command");
    await writeFile(
      path,
      stringify({ ...configuration, providerUsage: { executable } }),
    );

    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      `field '/providerUsage/executable' from '${path}': providerUsage.executable '${executable}' must be an available executable file`,
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
      readFile("features/heddle/README.md", "utf8"),
    ]);

    for (const guide of [operatorGuide, featureGuide]) {
      expect(guide).toContain("/home/vscode/.heddle");
      expect(guide).toContain("config.yml");
      expect(guide).toContain("worker.yml");
      expect(guide).toContain("0600");
      expect(guide).toContain("HEDDLE_CONFIG");
      expect(guide).toContain("--print-effective-configuration");
      expect(guide).toContain("1 through 65535");
      expect(guide).toContain("503 Service Unavailable");
    }
    expect(operatorGuide).toContain("providerUsage");
    expect(operatorGuide).not.toContain("session.launchPreparation");
    expect(operatorGuide).toContain(
      "Configuration changes require service restart",
    );
    expect(operatorGuide.replace(/\s+/g, " ")).toContain(
      "Escalation entries offer the exact recorded option labels as submitted answer values.",
    );
    expect(featureGuide).not.toContain("`boardPath`");
    expect(featureGuide).not.toContain("`statePath`");
    expect(featureGuide).not.toContain("`port`");
  });

  it("keeps the T3 ticket lifetime distinct from Heddle's client rule", async () => {
    const [operatorGuide, technicalDesign] = await Promise.all([
      readFile("docs/operators/production-composition.md", "utf8"),
      readFile("docs/technical-designs/heddle.yml", "utf8"),
    ]);
    const ticketContract =
      "The WebSocket ticket is short-lived. T3 accepts ticket reuse until expiry or parent-session revocation. Heddle never reuses the ticket and never persists or logs it.";

    expect(operatorGuide.replace(/\s+/g, " ")).toContain(ticketContract);
    expect(technicalDesign.replace(/\s+/g, " ")).toContain(ticketContract);
  });
});
