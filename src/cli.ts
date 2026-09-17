#!/usr/bin/env node
// ---
// relationships:
//   implements: blueprint-authoring
// ---
import { runCli } from "./cli-runner.js";

process.exitCode = runCli(process.argv.slice(2), {
  error: (message) => {
    console.error(message);
  },
  output: (message) => {
    console.log(message);
  },
});
