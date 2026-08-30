// ---
// relationships:
//   verifies: heddle
// ---

import { createServer, type Server as HttpServer } from "node:http";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

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
  });

  it("fails a configured provider-usage error before any T3 dispatch", async () => {
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
    production = createConfiguredProductionComposition(loaded, { t3 });

    await expect(production.start()).rejects.toThrow(
      "Provider usage command returned malformed or extra output",
    );
    expect(t3.commands).toEqual([]);
    expect(t3.timeouts).toEqual([]);
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
});
