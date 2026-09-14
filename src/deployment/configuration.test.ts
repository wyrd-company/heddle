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

import { defaultApprovalSettlementMilliseconds } from "../production/configuration.js";
import type { ProductionConfiguration } from "../production/index.js";
import {
  deploymentLaunchSettings,
  effectiveConfigurationDisclosure,
  loadDeploymentConfiguration,
  parseHeddleServerArguments,
  resolveConfigurationDirectory,
  validateProviderUsageConfiguration,
} from "./configuration.js";
import { layerConfiguration } from "./configuration-layering.js";

const fixture = (root: string): ProductionConfiguration => ({
  adHocProject: {
    label: "Sample worker",
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
      blueprintsRepositoryRoot: join(root, "state", "blueprints"),
      blueprintsSourceRoot: join(root, "blueprints"),
      configurationDirectory: root,
      configurationPath: join(root, "config.yml"),
      server: { host: "127.0.0.1", port: 3774 },
    });
  });

  it("loads a stable conventional configuration when source omits worker-local defaults", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-conventional-config-"));
    await prepareBlueprintRepository(root);
    const source = globalThis.structuredClone(
      fixture(root),
    ) as unknown as Record<string, unknown>;
    delete (source["adHocProject"] as Record<string, unknown>)["workspaceRoot"];
    delete source["boardDirectory"];
    delete (source["pacing"] as Record<string, unknown>)["usageWindowHours"];
    delete (source["pushover"] as Record<string, unknown>)["apiUrl"];
    delete source["stateDirectory"];
    delete (source["t3"] as Record<string, unknown>)["baseUrl"];
    expect(source).not.toHaveProperty("server");
    expect(source["session"]).not.toHaveProperty("worktreesRoot");
    await writeFile(join(root, "config.yml"), stringify(source));

    const first = await loadDeploymentConfiguration(root);
    const second = await loadDeploymentConfiguration(root);

    expect(first.configuration).toMatchObject({
      adHocProject: { workspaceRoot: "/workspaces" },
      boardDirectory: "/workspaces/kanban",
      pacing: { usageWindowHours: 5 },
      pushover: { apiUrl: "https://api.pushover.net/1/messages.json" },
      session: { worktreesRoot: "/workspaces/worktrees" },
      stateDirectory: "/var/lib/heddle",
      t3: { baseUrl: "http://127.0.0.1:3773" },
    });
    expect(first.server).toEqual({ host: "127.0.0.1", port: 3774 });
    expect(first.configurationProvenance).toMatchObject({
      "/adHocProject/workspaceRoot": "built-in",
      "/boardDirectory": "built-in",
      "/pacing/usageWindowHours": "built-in",
      "/pushover/apiUrl": "built-in",
      "/server/host": "built-in",
      "/server/port": "built-in",
      "/session/worktreesRoot": "built-in",
      "/stateDirectory": "built-in",
      "/t3/baseUrl": "built-in",
    });
    expect(second.configuration).toEqual(first.configuration);
    expect(second.server).toEqual(first.server);
  });

  it("keeps live-resource defaults paired with isolated fixture guidance", async () => {
    const guidance = await readFile(join(process.cwd(), "AGENTS.md"), "utf8");
    const normalized = guidance.replace(/\s+/g, " ");

    expect(normalized).toContain(
      "The conventional `t3.baseUrl` default resolves to it in this devcontainer.",
    );
    expect(normalized).toContain(
      "The conventional `boardDirectory` default resolves to it in this devcontainer.",
    );
    expect(normalized).toContain(
      "The conventional `pushover.apiUrl` default resolves to the real Pushover endpoint in this devcontainer",
    );
    expect(normalized).toContain(
      "Executable tests and direct-composition fixtures use an isolated T3 endpoint instead",
    );
    expect(normalized).toContain(
      "an explicit disposable board path or a disposable bind mount at `/workspaces/kanban`",
    );
    expect(normalized).toContain(
      "Executable tests and direct-composition fixtures use an isolated notification endpoint and disposable credentials.",
    );
    expect(normalized).toContain(
      "A production operator keeps the valid conventional default and does not override it to satisfy a test.",
    );
  });

  it("retains explicit overrides for every conventional worker value", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-conventional-overrides-"));
    await prepareBlueprintRepository(root);
    const source = fixture(root);
    source.adHocProject.workspaceRoot = join(root, "workspace-override");
    source.boardDirectory = join(root, "board-override");
    source.pushover.apiUrl = "https://proxy.example.invalid/messages";
    source.session.worktreesRoot = join(root, "worktrees-override");
    source.stateDirectory = join(root, "state-override");
    source.t3.baseUrl = "http://127.0.0.1:4173";
    await writeFile(
      join(root, "config.yml"),
      stringify({ ...source, server: { port: 4174 } }),
    );

    const loaded = await loadDeploymentConfiguration(root);

    expect(loaded.configuration).toMatchObject(source);
    expect(loaded.server).toEqual({ host: "127.0.0.1", port: 4174 });
    for (const pointer of [
      "/adHocProject/workspaceRoot",
      "/boardDirectory",
      "/pacing/usageWindowHours",
      "/pushover/apiUrl",
      "/server/port",
      "/session/worktreesRoot",
      "/stateDirectory",
      "/t3/baseUrl",
    ]) {
      expect(loaded.configurationProvenance?.[pointer]).toBe(
        join(root, "config.yml"),
      );
    }
  });

  it.each([
    {
      name: "adHocProject.workspaceRoot",
      pointer: "/adHocProject/workspaceRoot",
      mutate: (value: Record<string, unknown>) => {
        (value["adHocProject"] as Record<string, unknown>)["workspaceRoot"] =
          "relative";
      },
    },
    {
      name: "boardDirectory",
      pointer: "/boardDirectory",
      mutate: (value: Record<string, unknown>) => {
        value["boardDirectory"] = "relative";
      },
    },
    {
      name: "pacing.usageWindowHours",
      pointer: "/pacing/usageWindowHours",
      mutate: (value: Record<string, unknown>) => {
        (value["pacing"] as Record<string, unknown>)["usageWindowHours"] = 4;
      },
    },
    {
      name: "pushover.apiUrl",
      pointer: "/pushover/apiUrl",
      mutate: (value: Record<string, unknown>) => {
        (value["pushover"] as Record<string, unknown>)["apiUrl"] =
          "local-notifier";
      },
    },
    {
      name: "session.worktreesRoot",
      pointer: "/session/worktreesRoot",
      mutate: (value: Record<string, unknown>) => {
        (value["session"] as Record<string, unknown>)["worktreesRoot"] =
          "relative";
      },
    },
    {
      name: "stateDirectory",
      pointer: "/stateDirectory",
      mutate: (value: Record<string, unknown>) => {
        value["stateDirectory"] = "relative";
      },
    },
    {
      name: "t3.baseUrl",
      pointer: "/t3/baseUrl",
      mutate: (value: Record<string, unknown>) => {
        (value["t3"] as Record<string, unknown>)["baseUrl"] = "local-t3";
      },
    },
    {
      name: "server.port",
      pointer: "/server/port",
      mutate: (value: Record<string, unknown>) => {
        value["server"] = { port: 0 };
      },
    },
  ])(
    "rejects invalid conventional override $name at the deployed boundary",
    async ({ mutate, pointer }) => {
      root = await mkdtemp(join(tmpdir(), "heddle-conventional-invalid-"));
      await prepareBlueprintRepository(root);
      const source = globalThis.structuredClone(
        fixture(root),
      ) as unknown as Record<string, unknown>;
      mutate(source);
      await writeFile(join(root, "config.yml"), stringify(source));

      await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
        `field '${pointer}'`,
      );
    },
  );

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
    expect(loadedA.blueprintsSourceRoot).toBe(join(workerA, "blueprints"));
    expect(loadedA.blueprintsRepositoryRoot).toBe(
      join(root, "state-a", "blueprints"),
    );
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
    ).toBe(defaultApprovalSettlementMilliseconds);
    expect(loadedB.configuration.stateDirectory).toBe(join(shared, "state"));
    expect(loadedB.blueprintsSourceRoot).toBe(join(workerB, "blueprints"));
    expect(loadedB.blueprintsRepositoryRoot).toBe(
      join(shared, "state", "blueprints"),
    );
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

  it("treats an empty optional worker source as no override layer", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-layered-config-"));
    await prepareBlueprintRepository(root);
    const core = fixture(root);
    await writeFile(join(root, "config.yml"), stringify(core));
    const workerPath = join(root, "worker.yml");

    for (const source of ["", "# no differences\n", "null\n"]) {
      await writeFile(workerPath, source);
      const loaded = await loadDeploymentConfiguration(root);
      expect(loaded.configuration).toMatchObject(core);
      expect(loaded.workerConfigurationPath).toBeUndefined();
    }
  });

  it.each([
    {
      name: "omitted T3 object",
      mutate: (source: Record<string, unknown>) => {
        delete source["t3"];
      },
      pointer: "/t3/accessToken",
      source: "config",
    },
    {
      name: "omitted Pushover object",
      mutate: (source: Record<string, unknown>) => {
        delete source["pushover"];
      },
      pointer: "/pushover/applicationToken",
      source: "config",
    },
    {
      name: "partial T3 object",
      mutate: (source: Record<string, unknown>) => {
        source["t3"] = { baseUrl: "http://127.0.0.1:3999" };
      },
      pointer: "/t3/accessToken",
      source: "config",
    },
    {
      name: "partial Pushover object",
      mutate: (source: Record<string, unknown>) => {
        source["pushover"] = {
          apiUrl: "https://notify.invalid/messages",
          applicationToken: "application-secret-value",
          consoleBaseUrl: "https://console.invalid/",
        };
      },
      pointer: "/pushover/userKey",
      source: "config",
    },
    {
      name: "worker-cleared T3 object",
      worker: { t3: null },
      pointer: "/t3/accessToken",
      source: "worker",
    },
    {
      name: "worker-cleared Pushover object",
      worker: { pushover: null },
      pointer: "/pushover/applicationToken",
      source: "worker",
    },
  ])(
    "rejects $name credentials before any disposable service effect",
    async ({ mutate, worker, pointer, source }) => {
      root = await mkdtemp(join(tmpdir(), "heddle-missing-credential-"));
      const configurationPath = join(root, "config.yml");
      const workerPath = join(root, "worker.yml");
      const sourceValue = globalThis.structuredClone(
        fixture(root),
      ) as unknown as Record<string, unknown>;
      mutate?.(sourceValue);
      await writeFile(configurationPath, stringify(sourceValue));
      if (worker !== undefined) await writeFile(workerPath, stringify(worker));

      const provenancePath =
        source === "config" ? configurationPath : workerPath;
      await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
        `field '${pointer}' from '${provenancePath}'`,
      );
      await expect(access(join(root, "state"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("attributes missing required children to a worker-declared parent", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-layered-config-"));
    await prepareBlueprintRepository(root);
    await writeFile(join(root, "config.yml"), stringify(fixture(root)));
    const workerPath = join(root, "worker.yml");
    await writeFile(
      workerPath,
      stringify({ adjudication: { policyPath: "adjudication/policy.json" } }),
    );

    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      `field '/adjudication/providerAlias' from '${workerPath}'`,
    );
  });

  it("restores the conventional ad-hoc root after a worker clears the object", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-layered-config-"));
    await prepareBlueprintRepository(root);
    await writeFile(join(root, "config.yml"), stringify(fixture(root)));
    const workerPath = join(root, "worker.yml");
    await writeFile(workerPath, stringify({ adHocProject: null }));

    const loaded = await loadDeploymentConfiguration(root);
    expect(loaded.configuration.adHocProject).toEqual({
      workspaceRoot: "/workspaces",
    });
    expect(loaded.configurationClearedBy).toMatchObject({
      "/adHocProject": workerPath,
    });
  });

  it("keeps inherited map entries for an empty map and clears them with null", () => {
    const core = {
      pacing: { providerBudgets: { primary: { usageLimit: 80 } } },
    };
    const emptyMap = layerConfiguration([
      { source: "config.yml", value: core },
      { source: "worker.yml", value: { pacing: { providerBudgets: {} } } },
    ]);
    expect(emptyMap.value).toMatchObject(core);
    expect(
      (emptyMap.value as { pacing: { providerBudgets: unknown } }).pacing
        .providerBudgets,
    ).toEqual(core.pacing.providerBudgets);

    const cleared = layerConfiguration([
      { source: "config.yml", value: core },
      { source: "worker.yml", value: { pacing: { providerBudgets: null } } },
    ]);
    expect(cleared.value).toMatchObject({ pacing: { providerBudgets: {} } });
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

    await rm(workerPath);
    await mkdir(workerPath);
    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      `Configuration file '${workerPath}' cannot be read`,
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
        stageThresholds: {
          "worker-t3-secret": 20_000,
          "worker/tier~one": 30_000,
        },
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
      stageThresholds: {
        "[REDACTED]": 20_000,
        "worker/tier~one": 30_000,
      },
      t3: { accessToken: "[REDACTED]" },
    });
    expect(disclosure.provenance["/stageThresholds/[REDACTED]"]).toBe(
      workerPath,
    );
    expect(disclosure.provenance["/stageThresholds/worker~1tier~0one"]).toBe(
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
        server: { port: 4171 },
      }),
    );

    const loaded = await loadDeploymentConfiguration(root);

    expect(loaded.server).toEqual({ host: "127.0.0.1", port: 4171 });
    expect(loaded.configuration.boardDirectory).toBe(join(root, "board"));
    expect(loaded.configuration.stateDirectory).toBe(join(root, "state"));
  });

  it.each(["127.0.0.1", "0.0.0.0", "::", "192.0.2.10", null])(
    "rejects the internal server.host setting when configured as %s",
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
        `field '/server/host' from '${join(root, "config.yml")}': server.host is internal and cannot be configured`,
      );
    },
  );

  it("rejects a worker attempt to clear the internal server.host setting", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    await prepareBlueprintRepository(root);
    await writeFile(join(root, "config.yml"), stringify(fixture(root)));
    const workerPath = join(root, "worker.yml");
    await writeFile(workerPath, stringify({ server: { host: null } }));

    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      `field '/server/host' from '${workerPath}': server.host is internal and cannot be configured`,
    );
  });

  it("fails closed when the derived blueprint directory is absent or not the tracked clone root", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    const configurationPath = join(root, "config.yml");
    const repositoryRoot = join(root, "blueprints");
    await writeFile(configurationPath, stringify(fixture(root)));

    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      `Blueprint source '${repositoryRoot}' must be a git clone root whose current branch tracks origin`,
    );

    await mkdir(repositoryRoot);
    await writeFile(join(repositoryRoot, "sample.txt"), "not a clone\n");
    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      `Blueprint source '${repositoryRoot}' must be a git clone root whose current branch tracks origin`,
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
      `Blueprint source '${join(root, "blueprints")}' must be a git clone root whose current branch tracks origin`,
    );
  });

  it("derives worker synchronization state outside the shared blueprint source", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    const configuration = fixture(root);
    await writeFile(join(root, "config.yml"), stringify(configuration));
    await prepareBlueprintRepository(root);

    const loaded = await loadDeploymentConfiguration(root);

    expect(loaded.blueprintsSourceRoot).toBe(join(root, "blueprints"));
    expect(loaded.blueprintsRepositoryRoot).toBe(
      join(configuration.stateDirectory, "blueprints"),
    );
    await expect(
      access(loaded.blueprintsRepositoryRoot, constants.F_OK),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a state path that aliases the shared blueprint source", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    const configuration = fixture(root);
    await writeFile(join(root, "config.yml"), stringify(configuration));
    const workerPath = join(root, "worker.yml");
    await writeFile(workerPath, stringify({ stateDirectory: root }));
    await prepareBlueprintRepository(root);

    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      `field '/stateDirectory' from '${workerPath}': blueprint source and worker synchronization checkout must use disjoint paths`,
    );
  });

  it("rejects worker synchronization state nested inside the shared blueprint source", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-config-directory-"));
    const configuration = fixture(root);
    configuration.stateDirectory = join(root, "blueprints", "worker-state");
    await writeFile(join(root, "config.yml"), stringify(configuration));
    await prepareBlueprintRepository(root);

    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      `field '/stateDirectory' from '${join(root, "config.yml")}': blueprint source and worker synchronization checkout must use disjoint paths`,
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
        server: { port: 0 },
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
    const configuration = fixture(root);
    await writeFile(join(root, "config.yml"), stringify(configuration));
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
    await expect(
      access(configuration.stateDirectory, constants.F_OK),
    ).rejects.toThrow();
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

    const withoutCadence: Record<string, unknown> = { ...fixture(root) };
    delete withoutCadence["cadenceMilliseconds"];
    await writeFile(path, stringify(withoutCadence));
    await expect(loadDeploymentConfiguration(root)).rejects.toThrow(
      `field '/cadenceMilliseconds' from '${path}'`,
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
    const [operatorGuide, featureGuide, technicalDesign] = await Promise.all([
      readFile("docs/operators/production-composition.md", "utf8"),
      readFile("features/heddle/README.md", "utf8"),
      readFile("docs/technical-designs/heddle.yml", "utf8"),
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
    expect(operatorGuide.replace(/\s+/g, " ")).toContain(
      "Configuration ownership is independent from mount ownership.",
    );
    expect(featureGuide.replace(/\s+/g, " ")).toContain(
      "Those worker-local mounts do not require the paths to be repeated in `worker.yml`.",
    );
    expect(technicalDesign.replace(/\s+/g, " ")).toContain(
      "Configuration ownership is independent from mount ownership.",
    );
    for (const guide of [operatorGuide, featureGuide, technicalDesign]) {
      for (const conventionalValue of [
        "/workspaces/kanban",
        "/workspaces/worktrees",
        "/var/lib/heddle",
        "http://127.0.0.1:3773",
      ]) {
        expect(guide).toContain(conventionalValue);
      }
    }
    expect(operatorGuide).toContain("https://api.pushover.net/1/messages.json");
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
