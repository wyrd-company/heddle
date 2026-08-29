// ---
// relationships:
//   verifies: heddle
// ---

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

type WorkerResult = { code: number | null; stderr: string; stdout: string };

const runWorker = (
  mode: "crash-attention" | "crash-pushover" | "resume",
  root: string,
  deliveries: string,
): Promise<WorkerResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/production/escalation-crash-worker.ts",
        mode,
        root,
        deliveries,
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

describe("production escalation crash recovery", () => {
  let root = "";

  afterEach(async () => {
    if (root) await rm(root, { force: true, recursive: true });
  });

  it.each(["attention", "pushover"] as const)(
    "deduplicates the %s adapter after effect success before route completion",
    async (effect) => {
      root = await mkdtemp(join(tmpdir(), `heddle-${effect}-crash-`));
      await mkdir(join(root, "board"), { recursive: true });
      await mkdir(join(root, "repository"), { recursive: true });
      const deliveries = join(root, "deliveries.txt");
      await writeFile(deliveries, "");

      const crashed = await runWorker(`crash-${effect}`, root, deliveries);
      expect(crashed, crashed.stderr).toMatchObject({ code: 86 });

      const resumed = await runWorker("resume", root, deliveries);
      expect(resumed, resumed.stderr).toMatchObject({ code: 0 });
      const evidence = JSON.parse(resumed.stdout) as {
        attentionCount: number;
        deliveries: string[];
        routeTypes: string[];
      };
      expect(evidence.attentionCount).toBe(1);
      expect(evidence.deliveries).toEqual([
        '["task-17","task-17:implement","delivery-choice"]',
      ]);
      expect(evidence.routeTypes).toEqual(
        expect.arrayContaining([
          "mcp:escalation-opened",
          "mcp:escalation-attention-raised",
          "mcp:escalation-notified",
        ]),
      );
    },
  );
});
