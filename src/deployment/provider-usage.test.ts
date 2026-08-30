// ---
// relationships:
//   verifies: heddle
// ---

import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ExecutableProviderUsageSource,
  ProviderUsageCommandError,
  createUnconfiguredProviderUsageSource,
} from "./provider-usage.js";

const commandSource = `
import { writeFileSync } from "node:fs";

const [mode, artifact] = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  if (mode === "success") {
    writeFileSync(artifact, JSON.stringify({ argv: process.argv.slice(4), input }));
    process.stdout.write(JSON.stringify({ version: 1, used: 12.5, windowStartedAt: 1000 }) + "\\n");
  } else if (mode === "malformed") {
    process.stdout.write("not-json\\n");
  } else if (mode === "extra-output") {
    process.stdout.write('{"version":1,"used":1,"windowStartedAt":1000}\\n{}\\n');
  } else if (mode === "extra-field") {
    process.stdout.write(JSON.stringify({ version: 1, used: 1, windowStartedAt: 1000, ignored: true }));
  } else if (mode === "unsafe-used") {
    process.stdout.write(JSON.stringify({ version: 1, used: -1, windowStartedAt: 1000 }));
  } else if (mode === "unsafe-window") {
    process.stdout.write(JSON.stringify({ version: 1, used: 1, windowStartedAt: 1.5 }));
  } else if (mode === "wrong-version") {
    process.stdout.write(JSON.stringify({ version: 2, used: 1, windowStartedAt: 1000 }));
  } else if (mode === "nonzero") {
    process.stderr.write("external-auth-secret-value\\n");
    process.exitCode = 7;
  } else if (mode === "signal") {
    process.kill(process.pid, "SIGTERM");
  } else if (mode === "timeout") {
    writeFileSync(artifact, String(process.pid));
    process.on("SIGTERM", () => undefined);
    setInterval(() => undefined, 1000);
  }
});
`;

describe("configured provider usage command", () => {
  let root = "";
  let command = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-provider-usage-"));
    command = join(root, "command.mjs");
    await writeFile(command, commandSource);
  });

  afterEach(async () => {
    if (root !== "") await rm(root, { force: true, recursive: true });
  });

  const source = (
    mode: string,
    artifact = join(root, "artifact"),
    extraArguments: string[] = [],
    timeoutMilliseconds = 1_000,
  ): ExecutableProviderUsageSource =>
    new ExecutableProviderUsageSource({
      arguments: [command, mode, artifact, ...extraArguments],
      executable: process.execPath,
      timeoutMilliseconds,
    });

  it("uses a non-shell argv command and one exact versioned request", async () => {
    const request = join(root, "request.json");
    const marker = join(root, "must-not-exist");
    const literalArgument = `$(touch ${marker})`;

    await expect(
      source("success", request, [literalArgument]).readFiveHourWindow(
        "provider-a",
      ),
    ).resolves.toEqual({ used: 12.5, windowStartedAt: 1_000 });
    const captured = JSON.parse(await readFile(request, "utf8")) as {
      argv: string[];
      input: string;
    };
    expect(captured.argv).toEqual([literalArgument]);
    expect(captured.input).toBe(
      `${JSON.stringify({
        provider: "provider-a",
        version: 1,
        windowHours: 5,
      })}\n`,
    );
    await expect(access(marker, constants.F_OK)).rejects.toThrow();
  });

  it.each([
    ["malformed", "malformed or extra output"],
    ["extra-output", "malformed or extra output"],
    ["extra-field", "invalid shape"],
    ["unsafe-used", "non-negative finite number"],
    ["unsafe-window", "non-negative safe integer"],
    ["wrong-version", "version must be 1"],
    ["nonzero", "exited with status 7"],
    ["signal", "terminated by signal SIGTERM"],
  ])(
    "fails closed for %s without disclosing command output",
    async (mode, message) => {
      const error = await source(mode)
        .readFiveHourWindow("provider-a")
        .catch((candidate: unknown) => candidate);

      expect(error).toBeInstanceOf(ProviderUsageCommandError);
      expect(String(error)).toContain(message);
      expect(String(error)).not.toContain("external-auth-secret-value");
    },
  );

  it("fails closed if the executable disappears after startup preflight", async () => {
    const unavailable = new ExecutableProviderUsageSource({
      arguments: [],
      executable: join(root, "unavailable-command"),
      timeoutMilliseconds: 1_000,
    });

    await expect(unavailable.readFiveHourWindow("provider-a")).rejects.toThrow(
      "could not start",
    );
  });

  it("bounds execution and removes a command that ignores graceful termination", async () => {
    const pidPath = join(root, "pid");

    await expect(
      source("timeout", pidPath, [], 100).readFiveHourWindow("provider-a"),
    ).rejects.toThrow("exceeded 100ms");
    const pid = Number(await readFile(pidPath, "utf8"));

    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("fails if the empty-budget invariant ever consults provider usage", async () => {
    await expect(
      createUnconfiguredProviderUsageSource().readFiveHourWindow("provider-a"),
    ).rejects.toThrow("without a configured provider budget adapter");
  });
});
