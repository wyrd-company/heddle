// ---
// relationships:
//   implements: github-binding-and-intake
// ---
import { runCli, type CliIo } from "../cli-runner.js";
import { appClients, loadBindingConfig } from "./config.js";
import { liveRequirementFacts } from "./validate.js";
import {
  resolveServiceConfig,
  type StartOverrides,
} from "../service/config.js";
import { startService } from "../service/service.js";

function startOverrides(args: readonly string[]): StartOverrides {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index],
      value = args[index + 1];
    if (!flag || !value || !flag.startsWith("--"))
      throw new Error("Invalid heddle start arguments");
    values[flag] = value;
  }
  const known = new Set([
    "--config",
    "--state",
    "--database",
    "--poll-interval",
    "--github-app-credentials",
    "--t3-token",
    "--webhook-secret",
  ]);
  for (const flag of Object.keys(values))
    if (!known.has(flag))
      throw new Error(`Unknown heddle start option: ${flag}`);
  const polling = values["--poll-interval"];
  const pollingIntervalMs: number | undefined =
    polling === undefined ? undefined : Number(polling);
  if (
    polling !== undefined &&
    (!Number.isSafeInteger(pollingIntervalMs) || Number(pollingIntervalMs) <= 0)
  )
    throw new Error("--poll-interval must be a positive integer");
  return {
    ...(values["--config"] === undefined
      ? {}
      : { configPath: values["--config"] }),
    ...(values["--state"] === undefined
      ? {}
      : { stateDirectory: values["--state"] }),
    ...(values["--database"] === undefined
      ? {}
      : { databasePath: values["--database"] }),
    ...(pollingIntervalMs === undefined ? {} : { pollingIntervalMs }),
    ...(values["--github-app-credentials"] === undefined
      ? {}
      : { githubCredentialFile: values["--github-app-credentials"] }),
    ...(values["--t3-token"] === undefined
      ? {}
      : { t3TokenFile: values["--t3-token"] }),
    ...(values["--webhook-secret"] === undefined
      ? {}
      : { webhookSecretFile: values["--webhook-secret"] }),
  };
}
export async function runConfiguredCli(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  if (args[0] === "start" && args[1] !== "--help" && args[1] !== "-h") {
    try {
      const service = await startService(
        resolveServiceConfig(startOverrides(args.slice(1))),
        io,
      );
      await service.done;
      return typeof process.exitCode === "number" ? process.exitCode : 0;
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (
    args[0] !== "validate" ||
    !args.includes("--check-requires-issue") ||
    args.includes("--help") ||
    args.includes("--rules")
  )
    return runCli(args, io);
  const path = process.env["HEDDLE_CONFIG"];
  if (!path) return runCli(args, io);
  try {
    const config = loadBindingConfig(path);
    const budget = { graphql: 0, rest: 0, mutations: 0 };
    const clients = appClients(
      process.env["HEDDLE_GITHUB_APP_CREDENTIALS_FILE"] ??
        config.github.credentialFile,
      budget,
    );
    return runCli(args, io, {
      liveIssue: await liveRequirementFacts(clients, config.projects),
    });
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
