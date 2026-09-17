#!/usr/bin/env node
// ---
// relationships:
//   implements: blueprint-authoring
// ---
import { runConfiguredCli } from "./binding/cli.js";

process.exitCode = await runConfiguredCli(process.argv.slice(2), {
  error: (message) => {
    console.error(message);
  },
  output: (message) => {
    console.log(message);
  },
});
