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
import type { ResolvedProductionConfiguration } from "./configuration.js";

const execute = promisify(execFile);

const writeAgentNameThemes = async (repositoryRoot: string): Promise<void> => {
  await mkdir(join(repositoryRoot, "themes"), { recursive: true });
  await writeFile(
    join(repositoryRoot, "themes", "sample-team.yml"),
    `$schema: https://wyrd.company/heddle/agent-name-theme.schema.json
relationships: { implements: heddle }
kind: team
leader: sample-lead
companions: [sample-companion]
allies: [sample-ally]
antagonists: [sample-antagonist]
neutrals: [sample-neutral]
`,
  );
  await writeFile(
    join(repositoryRoot, "themes", "sample-soloist.yml"),
    `$schema: https://wyrd.company/heddle/agent-name-theme.schema.json
relationships: { implements: heddle }
kind: soloist
heroes: [sample-hero]
villains: [sample-villain]
bystanders: [sample-bystander]
`,
  );
};

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
    await writeAgentNameThemes(blueprintsRepositoryRoot);
    await execute("git", ["add", "themes"], {
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
        "Add agent-name themes",
      ],
      { cwd: blueprintsRepositoryRoot },
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

    const configuration: ResolvedProductionConfiguration = {
      adHocProject: {
        name: "Shared tasks",
        projectId: "workspace-project",
        workspaceRoot: root,
      },
      boardDirectory,
      cadenceMilliseconds: 60_000,
      incident: {
        approvalSeverityThreshold: "high",
        failureThreshold: 3,
        githubIssueRepository: "sample-owner/sample-repository",
        immediateEscalationCodes: [],
        retryDelayMilliseconds: 60_000,
        workspaceRoot: root,
      },
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
      providerAliases: {
        primary: {
          model: "sample-model",
          providerDisplayName: "Workbench Alpha",
        },
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
        defaultProviderAlias: "primary",
        defaultRuntimeMode: "auto-accept-edits",
        defaultSelection: {
          alias: "primary",
          driverKind: "codex",
          interactionMode: "default",
          model: {
            isCustom: false,
            name: "Sample Model",
            slug: "sample-model",
          },
          observedCliVersion: "0.91.0",
          providerDisplayName: "Workbench Alpha",
          providerInstanceId: "codex",
          runtimeMode: "auto-accept-edits",
        },
        resolvedSelections: [
          {
            alias: "primary",
            driverKind: "codex",
            interactionMode: "default",
            model: {
              isCustom: false,
              name: "Sample Model",
              slug: "sample-model",
            },
            observedCliVersion: "0.91.0",
            providerDisplayName: "Workbench Alpha",
            providerInstanceId: "codex",
            runtimeMode: "auto-accept-edits",
          },
        ],
        interactionMode: "default",
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

  it("rejects restart recovery before a mirror when the pinned prepare-worktree status was removed after the crash, then converges after repair", async () => {
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
    await writeFile(
      join(blueprintsRepositoryRoot, "todo-templates", "sample-stage.json"),
      JSON.stringify({
        items: [{ id: "deliver", text: "Deliver the sample" }],
      }),
    );
    await writeAgentNameThemes(blueprintsRepositoryRoot);
    await execute(
      "git",
      [
        "add",
        "handoff-templates/standard.md",
        "todo-templates/sample-stage.json",
        "themes",
      ],
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
        "Add sample templates",
      ],
      { cwd: blueprintsRepositoryRoot },
    );
    const handoffTemplateCommitSha = (
      await execute("git", ["rev-parse", "HEAD"], {
        cwd: blueprintsRepositoryRoot,
      })
    ).stdout.trim();
    await writeFile(
      join(blueprintsRepositoryRoot, "blueprints", "sample.json"),
      JSON.stringify({
        "board-statuses": {
          finalize: "done",
          "prepare-worktree": "in-progress",
        },
        edges: [
          { source: "prepare-worktree", target: "implement" },
          {
            condition: "result.output.dispositions.complete",
            description: "Complete the sample",
            disposition: "complete",
            source: "implement",
            target: "finalize",
          },
        ],
        nodes: [
          { id: "prepare-worktree", uses: "prepare-worktree" },
          {
            handoff: "standard",
            "handoff-template": {
              commitSha: handoffTemplateCommitSha,
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
    await writeFile(join(repositoryRoot, "README.md"), "# Sample repository\n");
    await execute("git", ["add", "README.md"], {
      cwd: repositoryRoot,
    });
    await execute("git", ["add", "blueprints"], {
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
    const boardConfiguration = `version: 11
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
`;
    await writeFile(join(boardDirectory, "config.yml"), boardConfiguration);
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
    const configuration: ResolvedProductionConfiguration = {
      adHocProject: {
        name: "Shared tasks",
        projectId: "workspace-project",
        workspaceRoot: root,
      },
      boardDirectory,
      cadenceMilliseconds: 60_000,
      incident: {
        approvalSeverityThreshold: "high",
        failureThreshold: 3,
        githubIssueRepository: "sample-owner/sample-repository",
        immediateEscalationCodes: [],
        retryDelayMilliseconds: 60_000,
        workspaceRoot: root,
      },
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
      providerAliases: {
        primary: {
          model: "sample-model",
          providerDisplayName: "Workbench Alpha",
        },
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
        defaultProviderAlias: "primary",
        defaultRuntimeMode: "auto-accept-edits",
        defaultSelection: {
          alias: "primary",
          driverKind: "codex",
          interactionMode: "default",
          model: {
            isCustom: false,
            name: "Sample Model",
            slug: "sample-model",
          },
          observedCliVersion: "0.91.0",
          providerDisplayName: "Workbench Alpha",
          providerInstanceId: "codex",
          runtimeMode: "auto-accept-edits",
        },
        resolvedSelections: [
          {
            alias: "primary",
            driverKind: "codex",
            interactionMode: "default",
            model: {
              isCustom: false,
              name: "Sample Model",
              slug: "sample-model",
            },
            observedCliVersion: "0.91.0",
            providerDisplayName: "Workbench Alpha",
            providerInstanceId: "codex",
            runtimeMode: "auto-accept-edits",
          },
        ],
        interactionMode: "default",
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
    const crashedTask = await execute(
      "kanban-md",
      ["--dir", boardDirectory, "show", "1", "--json"],
      { cwd: root },
    );
    expect((JSON.parse(crashedTask.stdout) as { status: string }).status).toBe(
      "in-progress",
    );
    const crashedPersistence = new SqlitePersistence({
      stateDirectory: configuration.stateDirectory,
    });
    const crashedContext = readLifecycleContext(
      crashedPersistence.getInstance("task-1")!,
    );
    expect(crashedPersistence.listSessionRuntime()).toMatchObject([
      {
        binding: {
          alias: "primary",
          driverKind: "codex",
          modelSlug: "sample-model",
          providerDisplayName: "Workbench Alpha",
          providerInstanceId: "codex",
        },
      },
    ]);
    crashedPersistence.close();
    const changedConfiguration: ResolvedProductionConfiguration = {
      ...configuration,
      incident: {
        approvalSeverityThreshold: "high",
        failureThreshold: 3,
        githubIssueRepository: "sample-owner/sample-repository",
        immediateEscalationCodes: [],
        retryDelayMilliseconds: 1,
        workspaceRoot: root,
      },
      pacing: { ...configuration.pacing, defaultProvider: "changed-provider" },
      providerAliases: {
        "changed-selection": {
          model: "changed-sample-model",
          providerDisplayName: "Changed Sample Workbench",
        },
      },
      session: {
        ...configuration.session,
        defaultProviderAlias: "changed-selection",
        defaultSelection: {
          ...configuration.session.defaultSelection,
          alias: "changed-selection",
          driverKind: "claudeAgent",
          model: {
            isCustom: false,
            name: "Changed Sample Model",
            slug: "changed-sample-model",
          },
          providerDisplayName: "Changed Sample Workbench",
          providerInstanceId: "changed-provider",
        },
        resolvedSelections: [
          {
            ...configuration.session.defaultSelection,
            alias: "changed-selection",
            driverKind: "claudeAgent",
            model: {
              isCustom: false,
              name: "Changed Sample Model",
              slug: "changed-sample-model",
            },
            providerDisplayName: "Changed Sample Workbench",
            providerInstanceId: "changed-provider",
          },
        ],
      },
    };
    await writeFile(configurationPath, JSON.stringify(changedConfiguration));
    const pinnedBlueprint = await execute(
      "git",
      ["cat-file", "blob", crashedContext.blueprintBlobHash],
      { cwd: blueprintsRepositoryRoot },
    );
    expect(
      (
        JSON.parse(pinnedBlueprint.stdout) as {
          "board-statuses": Record<string, string>;
        }
      )["board-statuses"]["prepare-worktree"],
    ).toBe("in-progress");
    const configuredPreparedStatus = "  - { name: in-progress }\n";
    expect(boardConfiguration).toContain(configuredPreparedStatus);
    const missingPreparedStatus = boardConfiguration.replace(
      configuredPreparedStatus,
      "",
    );
    expect(missingPreparedStatus).not.toContain(configuredPreparedStatus);
    await writeFile(join(boardDirectory, "config.yml"), missingPreparedStatus);
    type RestartEvidence = {
      attention: Array<{ code: string; message: string }>;
      bindings: Array<{
        alias: string;
        driverKind: string;
        modelSlug: string;
        providerDisplayName: string;
        providerInstanceId: string;
      }>;
      commands: Array<{ commandId: string; type: string }>;
      instanceCount: number;
      instances: Array<{ boardStatusMirrorBlocked?: boolean }>;
      runtime: Array<{ state: string }>;
      statusWrites: Array<{ status: string; taskId: number }>;
      taskStatus: string;
    };
    const rejected = await run("restart", configurationPath, commandLog);
    expect(rejected, rejected.stderr).toMatchObject({ code: 0 });
    const rejectedEvidence = JSON.parse(rejected.stdout) as RestartEvidence;
    expect(rejectedEvidence.statusWrites).toEqual([]);
    expect(rejectedEvidence.instances).toMatchObject([
      { boardStatusMirrorBlocked: true },
    ]);
    expect(rejectedEvidence.attention).toContainEqual(
      expect.objectContaining({
        code: "instance-synchronization-failed",
        message:
          'Instance task-1 synchronization failed: Blueprint board-statuses maps mechanical node use "prepare-worktree" to status "in-progress", which is absent from the board configuration',
      }),
    );
    expect(rejectedEvidence.taskStatus).toBe("in-progress");

    await writeFile(join(boardDirectory, "config.yml"), boardConfiguration);
    const restarted = await run("restart", configurationPath, commandLog);
    expect(restarted, restarted.stderr).toMatchObject({ code: 0 });
    const evidence = JSON.parse(restarted.stdout) as RestartEvidence;
    expect(evidence.attention).not.toContainEqual(
      expect.objectContaining({ code: "instance-synchronization-failed" }),
    );
    expect(evidence.instanceCount).toBe(1);
    expect(evidence.bindings).toMatchObject([
      {
        alias: "primary",
        driverKind: "codex",
        modelSlug: "sample-model",
        providerDisplayName: "Workbench Alpha",
        providerInstanceId: "codex",
      },
    ]);
    expect(
      evidence.commands.filter(({ type }) => type === "thread.create"),
    ).toHaveLength(1);
    expect(
      evidence.commands.filter(({ type }) => type === "thread.turn.start"),
    ).toHaveLength(1);
    expect(evidence.runtime).toMatchObject([
      { boardStatus: "in-progress", state: "waiting" },
    ]);
    expect(evidence.instances).toHaveLength(1);
    expect(evidence.instances[0]).not.toHaveProperty(
      "boardStatusMirrorBlocked",
    );
    expect(evidence.taskStatus).toBe("in-progress");

    await execute(
      "kanban-md",
      ["--dir", boardDirectory, "edit", "1", "--status", "todo"],
      { cwd: root },
    );
    const diverged = await run("restart", configurationPath, commandLog);
    expect(diverged, diverged.stderr).toMatchObject({ code: 0 });
    const divergenceEvidence = JSON.parse(diverged.stdout) as RestartEvidence;
    expect(divergenceEvidence.instances).toHaveLength(1);
    expect(divergenceEvidence.instances[0]).not.toHaveProperty(
      "boardStatusMirrorBlocked",
    );
    expect(divergenceEvidence.statusWrites).toEqual([
      { status: "in-progress", taskId: 1 },
    ]);
    expect(divergenceEvidence.taskStatus).toBe("in-progress");
  }, 30_000);
});
