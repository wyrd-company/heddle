#!/usr/bin/env node
// ---
// relationships:
//   implements: heddle
//   references: cursor-headless
// ---

import { spawn } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const apiKey =
  process.env.HEDDLE_CURSOR_API_KEY?.trim() ||
  process.env.CURSOR_API_KEY?.trim();
if (!apiKey) {
  console.error(
    "Cursor API-key authentication requires HEDDLE_CURSOR_API_KEY or CURSOR_API_KEY",
  );
  process.exit(78);
}

const environment = { ...process.env, CURSOR_API_KEY: apiKey };
delete environment.HEDDLE_CURSOR_API_KEY;
const shim = fileURLToPath(
  new URL("./cursor-acp-authenticate-shim.mjs", import.meta.url),
);
const child = spawn(process.execPath, [shim, ...process.argv.slice(2)], {
  env: environment,
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(`Failed to start Cursor authentication shim: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
