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
    const configuration = {
      ...fixture.configuration,
      pacing: {
        ...fixture.configuration.pacing,
        providerBudgets: { codex: { usageLimit: 80 } },
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
    production = createConfiguredProductionComposition(loaded, {
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

  it("binds before board, T3, Pushover, or persistence effects", async () => {
    fixture = await prepareProductionFixture();
    occupiedPort = createServer();
    const port = await listen(occupiedPort);
    const t3 = new SyntheticT3();
    const notifications: unknown[] = [];
    const beforeBoard = await directorySnapshot(
      fixture.configuration.boardDirectory,
    );
    await expect(
      access(fixture.configuration.stateDirectory),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const loaded: LoadedDeploymentConfiguration = {
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
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
    expect(t3.timeouts).toEqual([]);
    expect(notifications).toEqual([]);
  });

  it("writes a scheduler-owned production failure to stderr", async () => {
    fixture = await prepareProductionFixture();
    const loaded: LoadedDeploymentConfiguration = {
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      configurationDirectory: fixture.root,
      configurationPath: join(fixture.root, "config.yml"),
      server: { host: "127.0.0.1", port: 0 },
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
      configuration: fixture.configuration,
      configurationDirectory: fixture.root,
      configurationPath: join(fixture.root, "config.yml"),
      server: { host: "127.0.0.1", port: 3774 },
      timeoutApplication: {
        arguments: [],
        executable: process.execPath,
        timeoutMilliseconds: 1_000,
      },
    };
    production = createConfiguredProductionComposition(loaded, { t3 });

    await production.start();

    const turn = t3.commands.find(({ type }) => type === "thread.turn.start");
    const rendered = (turn?.["message"] as { text: string }).text;
    expect(rendered.startsWith(`${override}\n\n`)).toBe(true);
    expect(rendered).not.toContain("# Heddle stage session");
    expect(rendered).not.toContain(fixture.root);
  });

  it("raises durable attention without dispatch when heddle.md is unreadable", async () => {
    fixture = await prepareProductionFixture();
    await mkdir(join(fixture.root, "heddle.md"));
    const t3 = new SyntheticT3();
    const loaded: LoadedDeploymentConfiguration = {
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      configurationDirectory: fixture.root,
      configurationPath: join(fixture.root, "config.yml"),
      server: { host: "127.0.0.1", port: 3774 },
      timeoutApplication: {
        arguments: [],
        executable: process.execPath,
        timeoutMilliseconds: 1_000,
      },
    };
    production = createConfiguredProductionComposition(loaded, { t3 });

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
