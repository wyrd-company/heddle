// ---
// relationships:
//   implements: github-binding-and-intake
// ---
import { runCli, type CliIo } from "../cli-runner.js";
import { appClients, loadBindingConfig } from "./config.js";
import { liveRequirementFacts } from "./validate.js";
export async function runConfiguredCli(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
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
