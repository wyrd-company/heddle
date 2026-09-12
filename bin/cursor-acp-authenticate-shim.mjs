#!/usr/bin/env node
// ---
// relationships:
//   implements: heddle
//   references: cursor-headless
// ---

import { spawn } from "node:child_process";
import console from "node:console";
import process from "node:process";

const target = process.env.HEDDLE_CURSOR_AGENT_BINARY?.trim() || "cursor-agent";
const child = spawn(target, process.argv.slice(2), {
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});

const closeInput = () => {
  process.stdin.removeAllListeners("data");
  process.stdin.removeAllListeners("end");
  process.stdin.pause();
  child.stdin.destroy();
};
const childOutputEnded = new Promise((resolve) => {
  child.stdout.once("end", resolve);
});
const flushStdout = () =>
  new Promise((resolve, reject) => {
    process.stdout.write("", (error) => {
      if (error) reject(error);
      else resolve();
    });
  });

let spawnFailed = false;
child.once("error", (error) => {
  spawnFailed = true;
  console.error(`Failed to start Cursor Agent '${target}': ${error.message}`);
  closeInput();
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  closeInput();
  void (async () => {
    await childOutputEnded;
    await flushStdout();
    if (spawnFailed) return;
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  })();
});
child.stdout.pipe(process.stdout);

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newline = input.indexOf("\n");
  while (newline >= 0) {
    const line = input.slice(0, newline + 1);
    input = input.slice(newline + 1);
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      child.stdin.write(line);
      newline = input.indexOf("\n");
      continue;
    }

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      child.stdin.write(line);
      newline = input.indexOf("\n");
      continue;
    }

    if (message.method === "authenticate" && message.id !== undefined) {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`,
      );
    } else {
      child.stdin.write(line);
    }
    newline = input.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  if (input.length > 0) child.stdin.write(input);
  child.stdin.end();
});
