// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  harnessToolTimeoutLaunchConfiguration,
  type HarnessToolTimeoutLaunchInput,
} from "../control-plane/index.js";
import {
  ConfiguredT3ControlPlaneClient,
  TimeoutApplicationCommandError,
} from "./timeout-application.js";

const commandSource = `
import { writeFileSync } from "node:fs";

const [mode, artifact] = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  if (mode === "success") {
    writeFileSync(artifact, input);
    process.stdout.write(JSON.stringify({ version: 1, applied: true }) + "\\n");
  } else if (mode === "malformed") {
    process.stdout.write("not-json\\n");
  } else if (mode === "rejected") {
    process.stdout.write(JSON.stringify({ version: 1, applied: false }));
  } else if (mode === "nonzero") {
    process.stderr.write("external-auth-secret-value\\n");
    process.exitCode = 9;
  } else if (mode === "timeout") {
    writeFileSync(artifact, String(process.pid));
    process.on("SIGTERM", () => undefined);
    setInterval(() => undefined, 1000);
  }
});
`;

describe("configured T3 timeout application", () => {
  let root = "";
  let command = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-timeout-application-"));
    command = join(root, "command.mjs");
    await writeFile(command, commandSource);
  });

  afterEach(async () => {
    if (root !== "") await rm(root, { force: true, recursive: true });
  });

  const client = (
    mode: string,
    artifact = join(root, "artifact"),
    timeoutMilliseconds = 1_000,
    driver = "codex",
  ): ConfiguredT3ControlPlaneClient =>
    new ConfiguredT3ControlPlaneClient(
      { accessToken: "sample-access", baseUrl: "http://127.0.0.1:3999" },
      {
        [driver]: {
          arguments: [command, mode, artifact],
          executable: process.execPath,
          timeoutMilliseconds,
        },
      },
    );

  it.each(["codex", "claudeAgent"] as const)(
    "sends the exact accepted %s launch input and requires success",
    async (driver) => {
      const artifact = join(root, `${driver}.json`);
      const launch = harnessToolTimeoutLaunchConfiguration(driver)!;
      const input: HarnessToolTimeoutLaunchInput = {
        ...launch,
        providerInstanceId: `provider-${driver}`,
        sessionKey: "session-one",
        threadId: "thread-one",
        worktreePath: "/tmp/sample-worktree",
      };

      await client("success", artifact, 1_000, driver).applyHarnessToolTimeout(
        input,
      );

      await expect(readFile(artifact, "utf8")).resolves.toBe(
        `${JSON.stringify({
          configuration: input.configuration,
          driver,
          providerInstanceId: `provider-${driver}`,
          sessionKey: "session-one",
          threadId: "thread-one",
          version: 1,
          worktreePath: "/tmp/sample-worktree",
        })}\n`,
      );
    },
  );

  it.each([
    ["malformed", "malformed or extra output"],
    ["rejected", "exact versioned success acknowledgement"],
    ["nonzero", "exited with status 9"],
  ])("fails closed for %s without disclosing output", async (mode, message) => {
    const launch = harnessToolTimeoutLaunchConfiguration("codex")!;
    const error = await client(mode)
      .applyHarnessToolTimeout({
        ...launch,
        providerInstanceId: "provider-alpha",
        sessionKey: "session-one",
        threadId: "thread-one",
        worktreePath: "/tmp/sample-worktree",
      })
      .catch((candidate: unknown) => candidate);

    expect(error).toBeInstanceOf(TimeoutApplicationCommandError);
    expect(String(error)).toContain(message);
    expect(String(error)).not.toContain("external-auth-secret-value");
  });

  it("bounds execution and removes a command that ignores termination", async () => {
    const artifact = join(root, "pid");
    const launch = harnessToolTimeoutLaunchConfiguration("codex")!;

    await expect(
      client("timeout", artifact, 100).applyHarnessToolTimeout({
        ...launch,
        providerInstanceId: "provider-alpha",
        sessionKey: "session-one",
        threadId: "thread-one",
        worktreePath: "/tmp/sample-worktree",
      }),
    ).rejects.toThrow("exceeded 100ms");
    const pid = Number(await readFile(artifact, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("prepares a configured open driver and skips a missing map entry", async () => {
    const configuredArtifact = join(root, "configured.json");
    const configured = client(
      "success",
      configuredArtifact,
      1_000,
      "sample-driver",
    );
    const input: HarnessToolTimeoutLaunchInput = {
      ...harnessToolTimeoutLaunchConfiguration("sample-driver"),
      providerInstanceId: "provider-alpha",
      sessionKey: "session-one",
      threadId: "thread-one",
      worktreePath: "/tmp/sample-worktree",
    };

    await configured.applyHarnessToolTimeout(input);
    await expect(readFile(configuredArtifact, "utf8")).resolves.toContain(
      '"driver":"sample-driver"',
    );

    const missingArtifact = join(root, "missing.json");
    await client("success", missingArtifact).applyHarnessToolTimeout(input);
    await expect(readFile(missingArtifact, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
