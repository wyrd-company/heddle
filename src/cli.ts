#!/usr/bin/env node
// ---
// relationships:
//   implements: blueprint-authoring
// ---
import { runConfiguredCli } from "./binding/cli.js";

const args = process.argv.slice(2);
if (
  args.length === 3 &&
  args[0] === "hook" &&
  args[1] === "stop" &&
  (args[2] === "claude" || args[2] === "codex")
) {
  const { hookCli } = await import("./agent-tools/hooks.js");
  process.exitCode = await hookCli(args[2]);
} else if (
  args.length === 3 &&
  args[0] === "hook" &&
  args[1] === "export-plugins" &&
  args[2]
) {
  const { exportHookPlugins } = await import("./agent-tools/plugins.js");
  await exportHookPlugins(args[2]);
} else
  process.exitCode = await runConfiguredCli(args, {
    error: (message) => {
      console.error(message);
    },
    output: (message) => {
      console.log(message);
    },
  });
