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

import { SqlitePersistence } from "../persistence/index.js";
import type { PushoverMessage } from "./durable-adapters.js";

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

  const prepare = async (effect: "attention" | "pushover") => {
    root = await mkdtemp(join(tmpdir(), `heddle-${effect}-crash-`));
    await mkdir(join(root, "board"), { recursive: true });
    await mkdir(join(root, "repository"), { recursive: true });
    const deliveries = join(root, "deliveries.txt");
    await writeFile(deliveries, "");
    return deliveries;
  };

  type Evidence = {
    attentionCount: number;
    deliveries: PushoverMessage[];
    effectCompleted: boolean;
    effectIntentRecorded: boolean;
    routeTypes: string[];
  };

  it("deduplicates attention after effect success before route completion", async () => {
    const deliveries = await prepare("attention");

    const crashed = await runWorker("crash-attention", root, deliveries);
    expect(crashed, crashed.stderr).toMatchObject({ code: 86 });

    const resumed = await runWorker("resume", root, deliveries);
    expect(resumed, resumed.stderr).toMatchObject({ code: 0 });
    const evidence = JSON.parse(resumed.stdout) as Evidence;
    expect(evidence.attentionCount).toBe(1);
    expect(evidence.deliveries).toHaveLength(1);
    expect(evidence.routeTypes).toEqual(
      expect.arrayContaining([
        "mcp:escalation-opened",
        "mcp:escalation-attention-raised",
        "mcp:escalation-notified",
      ]),
    );
  });

  it("retries one ambiguous Pushover delivery with the same stable payload", async () => {
    const deliveries = await prepare("pushover");
    const stableId = '["task-17","task-17:implement","delivery-choice"]';

    const crashed = await runWorker("crash-pushover", root, deliveries);
    expect(crashed, crashed.stderr).toMatchObject({ code: 86 });
    const pending = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    expect(pending.effectIntentRecorded("pushover", stableId)).toBe(true);
    expect(pending.effectCompleted("pushover", stableId)).toBe(false);
    pending.close();

    const resumed = await runWorker("resume", root, deliveries);
    expect(resumed, resumed.stderr).toMatchObject({ code: 0 });
    const retryEvidence = JSON.parse(resumed.stdout) as Evidence;
    expect(retryEvidence.effectIntentRecorded).toBe(true);
    expect(retryEvidence.effectCompleted).toBe(true);
    expect(retryEvidence.deliveries).toHaveLength(2);
    expect(retryEvidence.deliveries[0]).toEqual(retryEvidence.deliveries[1]);
    expect(retryEvidence.deliveries[0]).toMatchObject({
      message: "Heddle escalation in implement",
      stableId,
      title: "Heddle needs attention",
    });
    expect(retryEvidence.routeTypes).toEqual(
      expect.arrayContaining([
        "mcp:escalation-opened",
        "mcp:escalation-attention-raised",
        "mcp:escalation-notified",
      ]),
    );
  });
});
