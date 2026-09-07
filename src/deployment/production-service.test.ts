// ---
// relationships:
//   verifies: heddle
// ---

import { createServer, type Server as HttpServer } from "node:http";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  prepareProductionFixture,
  SyntheticT3,
} from "../production/composition.test-support.js";
import type { ProductionComposition } from "../production/index.js";
import type {
  ProductionConfiguration,
  ResolvedProductionConfiguration,
} from "../production/index.js";
import type { LoadedDeploymentConfiguration } from "./configuration.js";
import {
  createConfiguredProductionComposition,
  startConfiguredProductionService,
} from "./production-service.js";

const listen = async (server: HttpServer): Promise<number> => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test HTTP server did not bind a TCP port");
  }
  return address.port;
};

const directorySnapshot = async (directory: string): Promise<string> => {
  const files: Array<[string, string]> = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else {
        files.push([
          relative(directory, path),
          (await readFile(path)).toString("base64"),
        ]);
      }
    }
  };
  await visit(directory);
  return JSON.stringify(files);
};

const configuredConfiguration = (
  resolved: ResolvedProductionConfiguration,
): ProductionConfiguration => {
  const { defaultProvider: _defaultProvider, ...pacing } = resolved.pacing;
  const { defaultSelection: _defaultSelection, ...session } = resolved.session;
  void _defaultProvider;
  void _defaultSelection;
  return { ...resolved, pacing, session };
};

describe("configured production composition", () => {
  let fixture: Awaited<ReturnType<typeof prepareProductionFixture>> | undefined;
  let commandDirectory = "";
  let occupiedPort: HttpServer | undefined;
  let production: ProductionComposition | undefined;

  afterEach(async () => {
    await production?.close();
    if (occupiedPort?.listening) {
      await new Promise<void>((resolve, reject) => {
        occupiedPort!.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    }
    await fixture?.cleanup();
    if (commandDirectory !== "") {
      await rm(commandDirectory, { force: true, recursive: true });
    }
    vi.restoreAllMocks();
  });

  it("resolves every loaded alias from one catalog snapshot before composition", async () => {
    fixture = await prepareProductionFixture();
    const configuration = configuredConfiguration(fixture.configuration);
    configuration.providerAliases = {
      primary: {
        model: "model-alpha",
        providerDisplayName: "Workbench Alpha",
      },
      reviewer: {
        model: "model-beta",
        providerDisplayName: "Workbench Beta",
      },
      specialist: {
        model: "custom-model",
        providerDisplayName: "Workbench Alpha",
      },
    };
    const readProviderCatalog = vi.fn(async () => [
      {
        availability: "available" as const,
        displayName: "Workbench Alpha",
        driverKind: "codex",
        enabled: true,
        installed: true,
        instanceId: "instance-alpha",
        models: [
          { isCustom: false, name: "Model Alpha", slug: "model-alpha" },
          { isCustom: true, name: "Custom Model", slug: "custom-model" },
        ],
        observedCliVersion: "0.91.0",
        state: "ready",
      },
      {
        availability: "available" as const,
        displayName: "Workbench Beta",
        driverKind: "codex",
        enabled: true,
        installed: true,
        instanceId: "instance-beta",
        models: [{ isCustom: false, name: "Model Beta", slug: "model-beta" }],
        observedCliVersion: "0.91.0",
        state: "ready",
      },
    ]);
    const t3 = new SyntheticT3();
    production = await createConfiguredProductionComposition(
      {
        blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
        configuration,
        configurationDirectory: fixture.root,
        configurationPath: join(fixture.root, "config.yml"),
        server: { host: "127.0.0.1", port: 3774 },
        timeoutApplication: {
          arguments: [],
          executable: process.execPath,
          timeoutMilliseconds: 1_000,
        },
      },
      { providerCatalog: { readProviderCatalog }, t3 },
    );

    expect(readProviderCatalog).toHaveBeenCalledTimes(1);
    expect(t3.commands).toEqual([]);
  });

  it("fails catalog startup without creating service state or disclosing transport detail", async () => {
    fixture = await prepareProductionFixture();
    const error = await createConfiguredProductionComposition(
      {
        blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
        configuration: configuredConfiguration(fixture.configuration),
        configurationDirectory: fixture.root,
        configurationPath: join(fixture.root, "config.yml"),
        server: { host: "127.0.0.1", port: 3774 },
      },
      {
        providerCatalog: {
          readProviderCatalog: async () => {
            throw new Error("transport included sensitive detail");
          },
        },
        t3: new SyntheticT3(),
      },
    ).catch((candidate: unknown) => candidate);

    expect(error).toMatchObject({
      message: "T3 provider catalog is unavailable",
      reason: "provider-catalog-unavailable",
    });
    expect(String(error)).not.toContain("sensitive detail");
    await expect(
      access(fixture.configuration.stateDirectory),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires the relocated timeout adapter for a resolved codex selection", async () => {
    fixture = await prepareProductionFixture();
    const t3 = new SyntheticT3();

    await expect(
      createConfiguredProductionComposition(
        {
          blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
          configuration: configuredConfiguration(fixture.configuration),
          configurationDirectory: fixture.root,
          configurationPath: join(fixture.root, "config.yml"),
          server: { host: "127.0.0.1", port: 3774 },
        },
        { t3 },
      ),
    ).rejects.toThrow(
      "session.timeoutApplication is required for driver 'codex'",
    );
    expect(t3.commands).toEqual([]);
  });

  it("rejects the relocated timeout adapter for a resolved other driver", async () => {
    fixture = await prepareProductionFixture();
    const t3 = new SyntheticT3();
    const readProviderCatalog = vi.fn(async () => [
      {
        availability: "available" as const,
        displayName: "Workbench Alpha",
        driverKind: "cursor",
        enabled: true,
        installed: true,
        instanceId: "cursor",
        models: [
          {
            isCustom: false,
            name: "Sample Model",
            slug: "sample-model",
          },
        ],
        observedCliVersion: "2026.08.25-3e8eec8",
        state: "ready",
      },
    ]);

    await expect(
      createConfiguredProductionComposition(
        {
          blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
          configuration: configuredConfiguration(fixture.configuration),
          configurationDirectory: fixture.root,
          configurationPath: join(fixture.root, "config.yml"),
          server: { host: "127.0.0.1", port: 3774 },
          timeoutApplication: {
            arguments: [],
            executable: process.execPath,
            timeoutMilliseconds: 1_000,
          },
        },
        { providerCatalog: { readProviderCatalog }, t3 },
      ),
    ).rejects.toThrow(
      "session.timeoutApplication must be omitted for driver 'cursor'",
    );
    expect(readProviderCatalog).toHaveBeenCalledTimes(1);
    expect(t3.commands).toEqual([]);
  });

  it("isolates a configured provider-usage error before any T3 dispatch", async () => {
    fixture = await prepareProductionFixture();
    commandDirectory = await mkdtemp(
      join(tmpdir(), "heddle-provider-failure-"),
    );
    const command = join(commandDirectory, "provider-usage.mjs");
    await writeFile(
      command,
      'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("invalid\\n"));\n',
    );
    const configured = configuredConfiguration(fixture.configuration);
    const configuration = {
      ...configured,
      pacing: {
        ...configured.pacing,
        providerBudgets: { primary: { usageLimit: 80 } },
      },
    };
    const loaded: LoadedDeploymentConfiguration = {
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration,
      configurationDirectory: commandDirectory,
      configurationPath: join(commandDirectory, "config.yml"),
      providerUsage: {
        arguments: [command],
        executable: process.execPath,
        timeoutMilliseconds: 1_000,
      },
      server: { host: "127.0.0.1", port: 0 },
      timeoutApplication: {
        arguments: [],
        executable: process.execPath,
        timeoutMilliseconds: 1_000,
      },
    };
    const t3 = new SyntheticT3();
    const onSchedulerError = vi.fn(async () => undefined);
    production = await createConfiguredProductionComposition(loaded, {
      onSchedulerError,
      t3,
    });

    await expect(production.start()).resolves.toBeUndefined();
    expect(t3.commands).toEqual([]);
    expect(t3.timeouts).toEqual([]);
    expect(onSchedulerError).not.toHaveBeenCalled();
    expect(production.attention.list()).toEqual([
      expect.objectContaining({
        kind: "production-error",
        message: expect.stringContaining(
          "Provider usage command returned malformed or extra output",
        ),
        scope: `task:${fixture.taskId}`,
      }),
    ]);
  });

  it("resolves catalog authority before bind without board, dispatch, Pushover, or persistence effects", async () => {
    fixture = await prepareProductionFixture();
    occupiedPort = createServer();
    const port = await listen(occupiedPort);
    const t3 = new SyntheticT3();
    const readProviderCatalog = vi.spyOn(t3, "readProviderCatalog");
    const notifications: unknown[] = [];
    const beforeBoard = await directorySnapshot(
      fixture.configuration.boardDirectory,
    );
    await expect(
      access(fixture.configuration.stateDirectory),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const loaded: LoadedDeploymentConfiguration = {
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: configuredConfiguration(fixture.configuration),
      configurationDirectory: fixture.root,
      configurationPath: join(fixture.root, "config.yml"),
      server: { host: "127.0.0.1", port },
      timeoutApplication: {
        arguments: [],
        executable: process.execPath,
        timeoutMilliseconds: 1_000,
      },
    };

    await expect(
      startConfiguredProductionService(loaded, {
        pushoverTransport: {
          send: async (message) => {
            notifications.push(message);
          },
        },
        t3,
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });

    expect(await directorySnapshot(fixture.configuration.boardDirectory)).toBe(
      beforeBoard,
    );
    await expect(
      access(fixture.configuration.stateDirectory),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(t3.commands).toEqual([]);
    expect(readProviderCatalog).toHaveBeenCalledTimes(1);
    expect(t3.timeouts).toEqual([]);
    expect(notifications).toEqual([]);
  });

  it("writes a scheduler-owned production failure to stderr", async () => {
    fixture = await prepareProductionFixture();
    const loaded: LoadedDeploymentConfiguration = {
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: configuredConfiguration(fixture.configuration),
      configurationDirectory: fixture.root,
      configurationPath: join(fixture.root, "config.yml"),
      server: { host: "127.0.0.1", port: 0 },
      timeoutApplication: {
        arguments: [],
        executable: process.execPath,
        timeoutMilliseconds: 1_000,
      },
    };
    await rm(fixture.configuration.boardDirectory, {
      force: true,
      recursive: true,
    });
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as typeof process.stderr.write);

    await expect(
      startConfiguredProductionService(loaded, { t3: new SyntheticT3() }),
    ).rejects.toThrow();

    expect(write).toHaveBeenCalledWith(
      expect.stringContaining("Heddle reconciliation pass failed:"),
    );
  });

  it("dispatches the wholesale override without prompt-source path or provenance", async () => {
    fixture = await prepareProductionFixture();
    const override =
      "# Operator session guidance\n\nUse the configured workflow.";
    await writeFile(join(fixture.root, "heddle.md"), override);
    const t3 = new SyntheticT3();
    const loaded: LoadedDeploymentConfiguration = {
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: configuredConfiguration(fixture.configuration),
      configurationDirectory: fixture.root,
      configurationPath: join(fixture.root, "config.yml"),
      server: { host: "127.0.0.1", port: 3774 },
      timeoutApplication: {
        arguments: [],
        executable: process.execPath,
        timeoutMilliseconds: 1_000,
      },
    };
    production = await createConfiguredProductionComposition(loaded, { t3 });

    await production.start();

    const turn = t3.commands.find(({ type }) => type === "thread.turn.start");
    const rendered = (turn?.["message"] as { text: string }).text;
    expect(rendered.startsWith(`${override}\n\n`)).toBe(true);
    expect(rendered).not.toContain("# Heddle stage session");
    expect(rendered).not.toContain(fixture.root);
    expect(t3.mcpRegistrations).toEqual([
      {
        authorizationHeader: expect.stringMatching(/^Bearer \S+$/),
        endpoint: "http://127.0.0.1:3774/mcp",
        threadId: expect.any(String),
      },
    ]);
    expect(rendered).not.toContain(
      t3.mcpRegistrations[0]!.authorizationHeader.slice("Bearer ".length),
    );
  });

  it("raises durable attention without dispatch when heddle.md is unreadable", async () => {
    fixture = await prepareProductionFixture();
    await mkdir(join(fixture.root, "heddle.md"));
    const t3 = new SyntheticT3();
    const loaded: LoadedDeploymentConfiguration = {
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: configuredConfiguration(fixture.configuration),
      configurationDirectory: fixture.root,
      configurationPath: join(fixture.root, "config.yml"),
      server: { host: "127.0.0.1", port: 3774 },
      timeoutApplication: {
        arguments: [],
        executable: process.execPath,
        timeoutMilliseconds: 1_000,
      },
    };
    production = await createConfiguredProductionComposition(loaded, { t3 });

    await expect(production.start()).resolves.toBeUndefined();

    expect(t3.commands).toEqual([]);
    expect(t3.timeouts).toEqual([]);
    expect(production.attention.list()).toEqual([
      expect.objectContaining({
        kind: "lifecycle-resolution",
        message: expect.stringContaining("System prompt override"),
      }),
    ]);
  });
});
