#!/usr/bin/env node

// ---
// relationships:
//   implements: heddle
// ---

import process from "node:process";

import {
  deploymentLaunchSettings,
  loadDeploymentConfiguration,
  parseHeddleServerArguments,
} from "../dist/deployment/configuration.js";
import { startHeddleServerFromEnvironment } from "../dist/deployment/server.js";

const main = async () => {
  const input = parseHeddleServerArguments(process.argv.slice(2), process.env);
  if (input.command === "help") {
    process.stdout.write(
      "Usage: heddle-server [--config <configuration-directory>] [--print-launch-settings]\n",
    );
    return;
  }
  const loaded = await loadDeploymentConfiguration(
    input.configurationDirectory,
  );
  if (input.command === "launch-settings") {
    process.stdout.write(
      `${JSON.stringify(deploymentLaunchSettings(loaded))}\n`,
    );
    return;
  }

  const service = await startHeddleServerFromEnvironment(process.env);
  const stop = async () => {
    await service.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
};

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Heddle failed to start"}\n`,
  );
  process.exitCode = 1;
}
