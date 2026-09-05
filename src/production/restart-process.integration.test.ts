// ---
// relationships:
//   verifies: heddle
// ---

import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupTerminationFixtures,
  git,
  makeLifecycleAtReview,
  mergeResume,
  readBranchHead,
  snapshotNow,
} from "../control-plane/mechanical-process-termination-fixture.js";
import { terminateAtBoundary } from "../control-plane/mechanical-process-termination-client.js";
import { readLifecycleContext } from "../engine/index.js";
import { SqlitePersistence } from "../persistence/index.js";
import type { ProductionConfiguration } from "./configuration.js";

const execute = promisify(execFile);

const run = (
  mode: "crash-after-activation" | "restart",
  configuration: string,
  log: string,
): Promise<{ code: number | null; stderr: string; stdout: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/production/restart-worker.ts",
        mode,
        configuration,
        log,
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

describe("production process restart", () => {
  let root = "";

  afterEach(async () => {
    if (root) await rm(root, { force: true, recursive: true });
    await cleanupTerminationFixtures();
  });

  it("replays a merge transition after the advancing process crashes", async () => {
    const fixture = await makeLifecycleAtReview(true);
    root = dirname(fixture.repositoryRoot);
    const killed = await terminateAtBoundary(
      fixture,
      mergeResume,
      "merge-command-started",
    );
    expect(killed.marker).toMatchObject({
      boundary: "merge-command-started",
      executable: "gitpr",
      phase: "before",
    });

    const boardDirectory = join(root, "board");
    const blueprintsRepositoryRoot = join(root, "blueprint-repository");
    const blueprintsRemote = join(root, "blueprint-origin.git");
    await mkdir(join(boardDirectory, "tasks"), { recursive: true });
    await writeFile(
      join(boardDirectory, "config.yml"),
      `version: 11
board: { name: Sample Board }
tasks_dir: tasks
statuses:
  - { name: backlog }
  - { name: todo }
  - { name: in-progress }
  - { name: review }
  - { name: retrospective }
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
next_id: 1
`,
    );
    const created = await execute(
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
    const taskId = (JSON.parse(created.stdout) as { id: number }).id;
    await execute(
      "git",
      [
        "clone",
        "--quiet",
        "--branch",
        "main",
        fixture.repositoryRoot,
        blueprintsRepositoryRoot,
      ],
      { cwd: root },
    );
    await execute("git", ["init", "--quiet", "--bare", blueprintsRemote], {
      cwd: root,
    });
    await execute("git", ["remote", "set-url", "origin", blueprintsRemote], {
      cwd: blueprintsRepositoryRoot,
    });
    await execute(
      "git",
      ["push", "--quiet", "--set-upstream", "origin", "main"],
      { cwd: blueprintsRepositoryRoot },
    );

    const persistence = new SqlitePersistence({
      stateDirectory: fixture.stateDirectory,
    });
    persistence.writeReconcilerRuntime({
      boardStatus: "in-progress",
      instanceId: "sample-lifecycle",
      state: "running",
      taskId,
    });
    expect(
      readLifecycleContext(persistence.getInstance("sample-lifecycle")!)
        .pendingTransition,
    ).toMatchObject({ operationId: mergeResume.operationId });
    persistence.close();

    const configuration: ProductionConfiguration = {
      adHocProject: {
        name: "Shared tasks",
        projectId: "workspace-project",
        workspaceRoot: root,
      },
      boardDirectory,
      cadenceMilliseconds: 60_000,
      observationThresholds: {
        endedMilliseconds: 60_000,
        failedMilliseconds: 60_000,
        stalledMilliseconds: 60_000,
      },
      pacing: {
        defaultProvider: "codex",
        maxConcurrentSessions: 1,
        providerBudgets: {},
        subagents: { maxDepth: 1, maxFanOut: 1 },
        usageWindowHours: 5,
      },
      products: [
        {
          name: "Sample product",
          repos: [
            {
              name: fixture.change.repositoryName,
              repositoryRoot: fixture.repositoryRoot,
            },
          ],
        },
      ],
      pushover: {
        apiUrl: "https://notify.invalid/messages",
        applicationToken: "application-token",
        consoleBaseUrl: "https://console.invalid/",
        userKey: "operator-key",
      },
      session: {
        baseRef: "main",
        cliVersion: "0.91.0",
        driver: "codex",
        interactionMode: "default",
        model: "sample-model",
        runtimeMode: "auto-accept-edits",
        skillPointer: "skill://sample",
        worktreesRoot: fixture.change.worktreesRoot,
      },
      stageThresholds: { review: 60_000 },
      stateDirectory: fixture.stateDirectory,
      stopTimeoutMilliseconds: 1_000,
      t3: { accessToken: "access-token", baseUrl: "http://127.0.0.1:3999" },
    };
    const configurationPath = join(root, "configuration.json");
    const commandLog = join(root, "t3-commands.jsonl");
    await writeFile(configurationPath, JSON.stringify(configuration));
    await writeFile(commandLog, "");

    const restarted = await run("restart", configurationPath, commandLog);
    expect(restarted, restarted.stderr).toMatchObject({ code: 0 });
    const recovered = new SqlitePersistence({
      stateDirectory: fixture.stateDirectory,
    });
    expect(
      readLifecycleContext(recovered.getInstance("sample-lifecycle")!),
    ).toMatchObject({
      awaitingNodeIds: ["retrospective"],
      pendingTransition: null,
      status: "awaiting",
    });
    recovered.close();
    expect(await readBranchHead(fixture.repositoryRoot, "main")).toBe(
      fixture.snapshot.sourceHead,
    );
    expect((await snapshotNow(fixture)).state).toBe("merged");
    expect(
      await git(fixture.repositoryRoot, "rev-list", "--merges", "main"),
    ).toBe("");
  }, 30_000);

  it("converges one instance, activation, and board write after a fresh process", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-process-restart-"));
    const repositoryRoot = join(root, "sample-repository");
    const blueprintsRepositoryRoot = join(root, "blueprint-repository");
    const blueprintsRemote = join(root, "blueprint-origin.git");
    const boardDirectory = join(root, "board");
    await mkdir(join(blueprintsRepositoryRoot, "blueprints"), {
      recursive: true,
    });
    await mkdir(join(blueprintsRepositoryRoot, "handoff-templates"), {
      recursive: true,
    });
    await mkdir(join(blueprintsRepositoryRoot, "todo-templates"), {
      recursive: true,
    });
    await mkdir(repositoryRoot, { recursive: true });
    await mkdir(join(boardDirectory, "tasks"), { recursive: true });
    await execute("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: repositoryRoot,
    });
    await execute("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: blueprintsRepositoryRoot,
    });
    const handoffTemplate = `---
$schema: https://wyrd.company/heddle/handoff-template.schema.json
relationships:
  implements: heddle
format: heddle.handoff-template
version: 1
kind: standard
---
# {{ task.title }}
`;
    await writeFile(
      join(blueprintsRepositoryRoot, "handoff-templates", "standard.md"),
      handoffTemplate,
    );
    const handoffTemplateBlobHash = (
      await execute(
        "git",
        ["hash-object", "-w", "handoff-templates/standard.md"],
        { cwd: blueprintsRepositoryRoot },
      )
    ).stdout.trim();
    await writeFile(
      join(blueprintsRepositoryRoot, "blueprints", "sample.json"),
      JSON.stringify({
        edges: [
          {
            condition: "result.output.dispositions.complete",
            description: "Complete the sample",
            disposition: "complete",
            source: "implement",
            target: "finalize",
          },
        ],
        nodes: [
          {
            handoff: "standard",
            "handoff-template": {
              blobHash: handoffTemplateBlobHash,
              path: "handoff-templates/standard.md",
            },
            id: "implement",
            tools: ["advance"],
            "todo-template": "sample-stage",
            uses: "wait",
          },
          { id: "finalize", uses: "finalize" },
        ],
      }),
    );
    await writeFile(
      join(blueprintsRepositoryRoot, "todo-templates", "sample-stage.json"),
      JSON.stringify({
        items: [{ id: "deliver", text: "Deliver the sample" }],
      }),
    );
    await writeFile(join(repositoryRoot, "README.md"), "# Sample repository\n");
    await execute("git", ["add", "README.md"], {
      cwd: repositoryRoot,
    });
    await execute(
      "git",
      ["add", "blueprints", "handoff-templates", "todo-templates"],
      { cwd: blueprintsRepositoryRoot },
    );
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
        "Add sample blueprint",
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
      { cwd: repositoryRoot },
    );
    await writeFile(
      join(boardDirectory, "config.yml"),
      `version: 11
board: { name: Sample Board }
tasks_dir: tasks
statuses:
  - { name: backlog }
  - { name: todo }
  - { name: in-progress }
  - { name: review }
  - { name: retrospective }
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
next_id: 1
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
        "todo",
        "--priority",
        "medium",
        "--tags",
        "lifecycle:sample",
        "--json",
      ],
      { cwd: root },
    );
    const configuration: ProductionConfiguration = {
      adHocProject: {
        name: "Shared tasks",
        projectId: "workspace-project",
        workspaceRoot: root,
      },
      boardDirectory,
      cadenceMilliseconds: 60_000,
      observationThresholds: {
        endedMilliseconds: 60_000,
        failedMilliseconds: 60_000,
        stalledMilliseconds: 60_000,
      },
      pacing: {
        defaultProvider: "codex",
        maxConcurrentSessions: 1,
        providerBudgets: {},
        subagents: { maxDepth: 1, maxFanOut: 1 },
        usageWindowHours: 5,
      },
      products: [
        {
          name: "Sample product",
          repos: [{ name: "sample-repository", repositoryRoot }],
        },
      ],
      pushover: {
        apiUrl: "https://notify.invalid/messages",
        applicationToken: "application-token",
        consoleBaseUrl: "https://console.invalid/",
        userKey: "operator-key",
      },
      session: {
        baseRef: "main",
        cliVersion: "0.91.0",
        driver: "codex",
        interactionMode: "default",
        model: "sample-model",
        runtimeMode: "auto-accept-edits",
        skillPointer: "skill://sample",
        worktreesRoot: join(root, "worktrees"),
      },
      stageThresholds: { implement: 60_000 },
      stateDirectory: join(root, "state"),
      stopTimeoutMilliseconds: 1_000,
      t3: { accessToken: "access-token", baseUrl: "http://127.0.0.1:3999" },
    };
    const configurationPath = join(root, "configuration.json");
    const commandLog = join(root, "t3-commands.jsonl");
    await writeFile(configurationPath, JSON.stringify(configuration));
    await writeFile(commandLog, "");

    const crashed = await run(
      "crash-after-activation",
      configurationPath,
      commandLog,
    );
    expect(crashed, crashed.stderr).toMatchObject({ code: 87 });
    const restarted = await run("restart", configurationPath, commandLog);
    expect(restarted, restarted.stderr).toMatchObject({ code: 0 });
    const evidence = JSON.parse(restarted.stdout) as {
      commands: Array<{ commandId: string; type: string }>;
      instanceCount: number;
      runtime: Array<{ state: string }>;
      taskStatus: string;
    };
    expect(evidence.instanceCount).toBe(1);
    expect(
      evidence.commands.filter(({ type }) => type === "thread.create"),
    ).toHaveLength(1);
    expect(
      evidence.commands.filter(({ type }) => type === "thread.turn.start"),
    ).toHaveLength(1);
    expect(evidence.runtime).toMatchObject([{ state: "waiting" }]);
    expect(evidence.taskStatus).toBe("in-progress");
  }, 30_000);
});
