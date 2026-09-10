// ---
// relationships:
//   verifies: heddle
// ---

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

type ActionKind = "approval" | "user-input";
type WorkerResult = { code: number | null; stderr: string; stdout: string };

const runWorker = (
  mode: "crash" | "resume",
  kind: ActionKind,
  root: string,
): Promise<WorkerResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/production/attention-action-crash-worker.ts",
        mode,
        kind,
        root,
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (value: string) => {
      stdout += value;
    });
    child.stderr.setEncoding("utf8").on("data", (value: string) => {
      stderr += value;
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr, stdout }));
  });

describe("production T3 attention action crash recovery", () => {
  let root = "";

  afterEach(async () => {
    if (root) await rm(root, { force: true, recursive: true });
  });

  it.each(["approval", "user-input"] as const)(
    "reconciles a recorded %s response after effect success before local completion",
    async (kind) => {
      root = await mkdtemp(join(tmpdir(), `heddle-${kind}-action-crash-`));
      await mkdir(join(root, "board"), { recursive: true });
      await mkdir(join(root, "repository"), { recursive: true });
      await writeFile(join(root, "attempts.jsonl"), "");

      const crashed = await runWorker("crash", kind, root);
      expect(crashed, crashed.stderr).toMatchObject({ code: 86 });

      const resumed = await runWorker("resume", kind, root);
      expect(resumed, resumed.stderr).toMatchObject({ code: 0 });
      const evidence = JSON.parse(resumed.stdout) as {
        completed: boolean;
        unresolved: number;
      };
      expect(evidence).toEqual({ completed: true, unresolved: 0 });
      const attempts = (await readFile(join(root, "attempts.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown);
      expect(attempts).toEqual([
        {
          commandId: `${kind}-attention`,
          kind,
          requestId: `${kind}-request`,
          ...(kind === "approval"
            ? { response: "accept" }
            : { response: { direction: ["First"] } }),
        },
      ]);
    },
  );
});
