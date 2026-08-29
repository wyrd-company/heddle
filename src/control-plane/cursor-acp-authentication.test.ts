// ---
// relationships:
//   verifies: heddle
//   references: cursor-headless
// ---

import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

const wrapper = resolve("bin/heddle-cursor-agent.mjs");
const scratchDirectories: string[] = [];

const runWrapper = async (
  input: string,
  environment: typeof process.env,
): Promise<{ code: number | null; stderr: string; stdout: string }> => {
  const child = spawn(wrapper, ["acp"], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolveExit) => {
    child.once("exit", resolveExit);
  });
  return { code, stderr, stdout };
};

afterEach(async () => {
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("packaged Cursor API-key authentication", () => {
  it("injects the API key and intercepts only authenticate requests", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "heddle-cursor-auth-"));
    scratchDirectories.push(scratch);
    const logPath = join(scratch, "forwarded.jsonl");
    const target = join(scratch, "cursor-agent.mjs");
    await writeFile(
      target,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import process from "node:process";
if (process.env.CURSOR_API_KEY !== "test-api-key") process.exit(77);
appendFileSync(process.env.TEST_FORWARD_LOG, JSON.stringify({ args: process.argv.slice(2) }) + "\\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newline = input.indexOf("\\n");
  while (newline >= 0) {
    const line = input.slice(0, newline + 1);
    input = input.slice(newline + 1);
    const message = JSON.parse(line);
    appendFileSync(process.env.TEST_FORWARD_LOG, JSON.stringify(message) + "\\n");
    if (message.method) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { forwarded: message.method } }) + "\\n");
    newline = input.indexOf("\\n");
  }
});
`,
      { mode: 0o755 },
    );
    await chmod(target, 0o755);
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "authenticate", params: {} },
      { jsonrpc: "2.0", id: 2, method: "initialize", params: { value: 1 } },
      { jsonrpc: "2.0", id: 3, method: "session/new", params: { value: 2 } },
    ];

    const result = await runWrapper(
      `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
      {
        ...process.env,
        HEDDLE_CURSOR_AGENT_BINARY: target,
        HEDDLE_CURSOR_API_KEY: "test-api-key",
        TEST_FORWARD_LOG: logPath,
      },
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual(
      expect.arrayContaining([
        { jsonrpc: "2.0", id: 1, result: {} },
        { jsonrpc: "2.0", id: 2, result: { forwarded: "initialize" } },
        { jsonrpc: "2.0", id: 3, result: { forwarded: "session/new" } },
      ]),
    );
    const forwarded = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(forwarded).toEqual([{ args: ["acp"] }, requests[1], requests[2]]);
  });

  it("refuses to start without an API key", async () => {
    const environment = { ...process.env };
    delete environment.HEDDLE_CURSOR_API_KEY;
    delete environment.CURSOR_API_KEY;

    const result = await runWrapper("", environment);

    expect(result.code).toBe(78);
    expect(result.stderr).toContain(
      "Cursor API-key authentication requires HEDDLE_CURSOR_API_KEY or CURSOR_API_KEY",
    );
  });
});
