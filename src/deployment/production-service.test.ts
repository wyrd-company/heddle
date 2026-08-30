// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import {
  prepareProductionFixture,
  SyntheticT3,
} from "../production/composition.test-support.js";
import type { ProductionComposition } from "../production/index.js";
import type { LoadedDeploymentConfiguration } from "./configuration.js";
import { createConfiguredProductionComposition } from "./production-service.js";

describe("configured production composition", () => {
  let fixture: Awaited<ReturnType<typeof prepareProductionFixture>> | undefined;
  let commandDirectory = "";
  let production: ProductionComposition | undefined;

  afterEach(async () => {
    await production?.close();
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
});
