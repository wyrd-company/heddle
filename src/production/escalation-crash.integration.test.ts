// ---
// relationships:
//   verifies: heddle
// ---

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { escalationAttentionId } from "../mcp-server/escalation-contract.js";
import { SqlitePersistence } from "../persistence/index.js";
import type { PushoverMessage } from "./durable-adapters.js";

const execute = promisify(execFile);

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
    const boardDirectory = join(root, "board");
    const blueprintsRepositoryRoot = join(root, "blueprint-repository");
    const blueprintsRemote = join(root, "blueprint-origin.git");
    await mkdir(join(boardDirectory, "tasks"), { recursive: true });
    await mkdir(join(blueprintsRepositoryRoot, "blueprints"), {
      recursive: true,
    });
    await mkdir(join(root, "repository"), { recursive: true });
    await writeFile(
      join(boardDirectory, "config.yml"),
      `version: 11
board: { name: Sample Board }
tasks_dir: tasks
statuses:
  - { name: backlog }
  - { name: todo }
  - { name: in-progress }
  - { name: uat }
  - { name: done }
priorities:
  - low
  - medium
  - high
defaults: { status: backlog, priority: medium, class: standard }
claim_timeout: 1h
classes:
  - { name: standard }
tui: { title_lines: 2, age_thresholds: [] }
next_id: 17
`,
    );
    await execute(
      "kanban-md",
      [
        "--dir",
        boardDirectory,
        "create",
        "Example Item",
        "--status",
        "in-progress",
        "--tags",
        "lifecycle:sample",
        "--json",
      ],
      { cwd: root },
    );
    await writeFile(join(blueprintsRepositoryRoot, "README.md"), "# Fixture\n");
    await execute("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: blueprintsRepositoryRoot,
    });
    await execute("git", ["add", "README.md"], {
      cwd: blueprintsRepositoryRoot,
    });
    await execute(
      "git",
      [
        "-c",
        "user.name=Fixture User",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Add fixture",
      ],
      { cwd: blueprintsRepositoryRoot },
    );
    await execute("git", ["init", "--quiet", "--bare", blueprintsRemote], {
      cwd: root,
    });
    await execute("git", ["remote", "add", "origin", blueprintsRemote], {
      cwd: blueprintsRepositoryRoot,
    });
    await execute(
      "git",
      ["push", "--quiet", "--set-upstream", "origin", "main"],
      { cwd: blueprintsRepositoryRoot },
    );
    const deliveries = join(root, "deliveries.txt");
    await writeFile(deliveries, "");
    return deliveries;
  };

  type Evidence = {
    attentionIds: string[];
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
    const stableId = escalationAttentionId(
      "task-17",
      "task-17:implement",
      "delivery-choice",
    );
    expect(
      evidence.attentionIds.filter((attentionId) => attentionId === stableId),
    ).toHaveLength(1);
    expect(evidence.deliveries).toHaveLength(1);
    expect(evidence.routeTypes).toEqual([
      "mcp:escalation-opened",
      "mcp:escalation-attention-raised",
      "mcp:escalation-notified",
    ]);
  });

  it("retries one ambiguous Pushover delivery with the same stable payload", async () => {
    const deliveries = await prepare("pushover");
    const stableId = escalationAttentionId(
      "task-17",
      "task-17:implement",
      "delivery-choice",
    );

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
    expect(retryEvidence.routeTypes).toEqual([
      "mcp:escalation-opened",
      "mcp:escalation-attention-raised",
      "mcp:escalation-notified",
    ]);
  });

  it("validates the startup tool registry before replaying external effects", async () => {
    const deliveries = await prepare("pushover");
    const crashed = await runWorker("crash-pushover", root, deliveries);
    expect(crashed, crashed.stderr).toMatchObject({ code: 86 });
    const repositoryRoot = join(root, "blueprint-repository");
    await writeFile(
      join(repositoryRoot, "blueprints", "invalid.json"),
      JSON.stringify({
        edges: [],
        nodes: [{ id: "inspect", tools: ["missing_tool"], uses: "wait" }],
      }),
    );
    await execute("git", ["add", "blueprints/invalid.json"], {
      cwd: repositoryRoot,
    });
    await execute(
      "git",
      [
        "-c",
        "user.name=Fixture User",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Add invalid registry fixture",
      ],
      { cwd: repositoryRoot },
    );
    await execute("git", ["push", "--quiet", "origin", "main"], {
      cwd: repositoryRoot,
    });

    const failed = await runWorker("resume", root, deliveries);

    expect(failed).toMatchObject({ code: 1 });
    expect(failed.stderr).toContain(
      "declares MCP tool 'missing_tool' that is not registered",
    );
    expect(
      (await readFile(deliveries, "utf8")).split("\n").filter(Boolean),
    ).toHaveLength(1);
  });
});
