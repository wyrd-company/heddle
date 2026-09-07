// ---
// relationships:
//   verifies: heddle
// ---

import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

const runWorker = (
  mode: "crash" | "resume",
  root: string,
): Promise<{ code: number | null; stderr: string; stdout: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/production/incident-finalize-crash-worker.ts",
        mode,
        root,
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout
      .setEncoding("utf8")
      .on("data", (value: string) => (stdout += value));
    child.stderr
      .setEncoding("utf8")
      .on("data", (value: string) => (stderr += value));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr, stdout }));
  });

describe("incident finalize process crash recovery", () => {
  let root = "";

  afterEach(async () => {
    if (root !== "") await rm(root, { force: true, recursive: true });
  });

  it("records one real gh issue attempt when finalize replays after a post-attempt crash", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-incident-finalize-crash-"));
    const executableDirectory = join(root, "bin");
    await mkdir(executableDirectory);
    const executable = join(executableDirectory, "gh");
    await writeFile(
      executable,
      `#!/usr/bin/env node
const { appendFile } = await import("node:fs/promises");
await appendFile(${JSON.stringify(join(root, "issue-attempts.jsonl"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
`,
    );
    await chmod(executable, 0o755);
    await writeFile(join(root, "commands.jsonl"), "");
    await writeFile(join(root, "issue-attempts.jsonl"), "");

    const crashed = await runWorker("crash", root);
    expect(crashed, crashed.stderr).toMatchObject({ code: 86 });

    const resumed = await runWorker("resume", root);
    expect(resumed, resumed.stderr).toMatchObject({ code: 0 });
    const evidence = JSON.parse(resumed.stdout) as {
      finalizeSessions: Array<{
        activation: number;
        sessionKey: string;
        threadId: string;
      }>;
      issueAttempts: string[][];
      runtime: { incidentId: string; stageId: string; state: string };
    };
    expect(evidence.issueAttempts).toEqual([
      [
        "issue",
        "create",
        "--title",
        "Record production incident",
        "--body",
        `Incident: ${evidence.runtime.incidentId}`,
      ],
    ]);
    expect(evidence.finalizeSessions).toEqual([
      expect.objectContaining({ activation: 1 }),
    ]);
    expect(evidence.runtime).toMatchObject({
      stageId: "finalize",
      state: "waiting",
    });
  });
});
