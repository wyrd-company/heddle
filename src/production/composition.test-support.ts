// ---
// relationships:
//   verifies: heddle
// ---

import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type {
  HarnessToolTimeoutLaunchInput,
  T3DispatchCommand,
  T3WorkflowMcpProviderSession,
} from "../control-plane/index.js";
import type { ProductionConfiguration } from "./configuration.js";
import type { ProductionT3Client } from "./composition.js";

export const execute = promisify(execFile);

const gitBlobHash = (content: string): string =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest("hex");

const standardHandoffTemplate = `---
$schema: https://wyrd.company/heddle/handoff-template.schema.json
relationships:
  implements: heddle
format: heddle.handoff-template
version: 1
kind: standard
---
# {{ task.title }}

Stage: {{ handoff.stage.name }}

Prior outputs: {{ handoff.stage.priorStageOutputs | stableJson }}

{% for list in handoff.todoList.lists %}{% for item in list.items %}- [{% if item.checked %}x{% else %} {% endif %}] {{ item.text }}
{% endfor %}{% endfor %}`;

const remediationHandoffTemplate = `---
$schema: https://wyrd.company/heddle/handoff-template.schema.json
relationships:
  implements: heddle
format: heddle.handoff-template
version: 1
kind: remediation
---
# {{ task.title }}

Stage: {{ handoff.stage.name }}

{% if handoff.stage.remediationCause and handoff.stage.remediationCause.kind == "review-basis-drift" %}
The reviewed basis changed before merge.
{% elif handoff.stage.remediationCause and handoff.stage.remediationCause.kind == "review-source-behind" %}
The reviewed source did not contain the target when the review snapshot was captured.
{% endif %}
{% if handoff.stage.remediationCause and (handoff.stage.remediationCause.kind == "review-basis-drift" or handoff.stage.remediationCause.kind == "review-source-behind") %}
Rebase source branch {{ handoff.stage.remediationCause.sourceBranch }} at {{ handoff.stage.remediationCause.currentSourceHead }} onto target branch {{ handoff.stage.remediationCause.targetBranch }} at exact head {{ handoff.stage.remediationCause.currentTargetHead }} without creating a merge commit. Preserve task-scoped changes, resolve conflicts, validate, commit only task-scoped changes, verify the exact target head is an ancestor of the current source HEAD, and verify the worktree is clean before calling advance.
{% endif %}

Review findings: {{ handoff.stage.reviewFindings | stableJson }}

Remediation cause: {{ handoff.stage.remediationCause | stableJson }}

{% for list in handoff.todoList.lists %}{% for item in list.items %}- [{% if item.checked %}x{% else %} {% endif %}] {{ item.text }}
{% endfor %}{% endfor %}`;

export class SyntheticT3 implements ProductionT3Client {
  readonly approvalResponses: Array<{
    decision: "accept" | "reject";
    commandId?: string;
    requestId: string;
    threadId: string;
  }> = [];
  readonly commands: T3DispatchCommand[] = [];
  readonly mcpRegistrations: T3WorkflowMcpProviderSession[] = [];
  readonly timeouts: HarnessToolTimeoutLaunchInput[] = [];
  readonly threads = new Set<string>();
  readonly userInputResponses: Array<{
    answers: Record<string, string | string[]>;
    commandId?: string;
    requestId: string;
    threadId: string;
  }> = [];

  async applyHarnessToolTimeout(
    input: HarnessToolTimeoutLaunchInput,
  ): Promise<void> {
    this.timeouts.push(input);
  }

  async dispatch(command: T3DispatchCommand): Promise<{ sequence: number }> {
    this.commands.push(globalThis.structuredClone(command));
    if (command.type === "thread.create" && command.threadId !== undefined) {
      this.threads.add(command.threadId);
    }
    return { sequence: this.commands.length };
  }

  async getShell() {
    return {
      threads: [...this.threads].map((id) => ({
        id,
        latestTurn: { state: "running" },
        session: { status: "running" },
      })),
    };
  }

  async registerWorkflowMcpProviderSession(
    registration: T3WorkflowMcpProviderSession,
  ): Promise<void> {
    this.mcpRegistrations.push(globalThis.structuredClone(registration));
  }

  async getThread() {
    return { thread: { activities: [] } };
  }

  async respondToApproval(
    threadId: string,
    requestId: string,
    decision: "accept" | "reject",
    commandId?: string,
  ) {
    this.approvalResponses.push({
      ...(commandId === undefined ? {} : { commandId }),
      decision,
      requestId,
      threadId,
    });
    return { sequence: 1 };
  }

  async respondToUserInput(
    threadId: string,
    requestId: string,
    answers: Record<string, string | string[]>,
    commandId?: string,
  ) {
    this.userInputResponses.push({
      answers,
      ...(commandId === undefined ? {} : { commandId }),
      requestId,
      threadId,
    });
    return { sequence: 1 };
  }
}

export type ProductionFixture = {
  blueprintsRepositoryRoot: string;
  cleanup(): Promise<void>;
  configuration: ProductionConfiguration;
  repositoryRoot: string;
  root: string;
  taskId: number;
};

export type ProductionEpicFixture = ProductionFixture & { epicId: number };

export const prepareProductionFixture =
  async (): Promise<ProductionFixture> => {
    const root = await mkdtemp(join(tmpdir(), "heddle-production-"));
    const repositoryRoot = join(root, "sample-repository");
    const blueprintsRepositoryRoot = join(root, "blueprint-repository");
    const blueprintsRemote = join(root, "blueprint-origin.git");
    const boardDirectory = join(root, "sample-board");
    const stateDirectory = join(root, "state");
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
    await writeFile(
      join(blueprintsRepositoryRoot, "blueprints", "sample.json"),
      JSON.stringify({
        $schema: "https://wyrd.company/heddle/lifecycle-blueprint.schema.json",
        relationships: {
          implements: "heddle",
          uses: ["sample-stage"],
        },
        edges: [
          {
            condition: "result.output.dispositions.complete",
            description: "Complete the sample",
            disposition: "complete",
            source: "implement",
            target: "review",
          },
          {
            condition: "result.output.dispositions.complete",
            description: "Complete review",
            disposition: "complete",
            source: "review",
            target: "finalize",
          },
          {
            condition: "result.output.dispositions.reject",
            description: "Remediate the sample",
            disposition: "reject",
            source: "review",
            target: "remediate",
          },
          {
            condition: "result.output.dispositions.complete",
            description: "Complete remediation",
            disposition: "complete",
            source: "remediate",
            target: "review",
          },
        ],
        nodes: [
          {
            handoff: "standard",
            "handoff-template": {
              blobHash: gitBlobHash(standardHandoffTemplate),
              path: "handoff-templates/standard.md",
            },
            id: "implement",
            tools: [
              "advance",
              "answer",
              "create_finding",
              "create_follow_up",
              "liveness",
              "spawn",
            ],
            "todo-template": "sample-stage",
            uses: "wait",
          },
          {
            id: "review",
            handoff: "standard",
            "handoff-template": {
              blobHash: gitBlobHash(standardHandoffTemplate),
              path: "handoff-templates/standard.md",
            },
            config: { joinStrategy: "any" },
            tools: [
              "advance",
              "answer",
              "create_finding",
              "create_follow_up",
              "liveness",
              "spawn",
            ],
            "todo-template": "sample-stage",
            uses: "wait",
          },
          {
            id: "remediate",
            handoff: "remediation",
            "handoff-template": {
              blobHash: gitBlobHash(remediationHandoffTemplate),
              path: "handoff-templates/remediation.md",
            },
            config: { joinStrategy: "any" },
            tools: [
              "advance",
              "answer",
              "create_finding",
              "create_follow_up",
              "liveness",
              "spawn",
            ],
            "todo-template": "sample-stage",
            uses: "wait",
          },
          { id: "finalize", uses: "finalize" },
        ],
      }),
    );
    await writeFile(
      join(blueprintsRepositoryRoot, "blueprints", "mechanical.json"),
      JSON.stringify({
        $schema: "https://wyrd.company/heddle/lifecycle-blueprint.schema.json",
        relationships: {
          implements: "heddle",
          uses: ["sample-stage"],
        },
        edges: [
          { source: "prepare-worktree", target: "implement" },
          {
            condition: "result.output.dispositions.complete",
            description: "Complete the mechanical sample",
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
              blobHash: gitBlobHash(standardHandoffTemplate),
              path: "handoff-templates/standard.md",
            },
            id: "implement",
            repo: "sample-repository",
            tools: [
              "advance",
              "answer",
              "create_finding",
              "create_follow_up",
              "liveness",
              "spawn",
            ],
            "todo-template": "sample-stage",
            uses: "wait",
          },
          { id: "finalize", uses: "finalize" },
        ],
      }),
    );
    await writeFile(
      join(blueprintsRepositoryRoot, "handoff-templates", "standard.md"),
      standardHandoffTemplate,
    );
    await writeFile(
      join(blueprintsRepositoryRoot, "handoff-templates", "remediation.md"),
      remediationHandoffTemplate,
    );
    await writeFile(
      join(blueprintsRepositoryRoot, "todo-templates", "sample-stage.json"),
      JSON.stringify({
        items: [{ id: "deliver", text: "Deliver the sample" }],
      }),
    );
    await writeFile(join(repositoryRoot, "README.md"), "# Sample repository\n");
    await execute("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: repositoryRoot,
    });
    await execute("git", ["add", "README.md"], {
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
        "Add sample lifecycle",
      ],
      { cwd: repositoryRoot },
    );
    await execute("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: blueprintsRepositoryRoot,
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
        "Add sample lifecycle",
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
      {
        cwd: blueprintsRepositoryRoot,
      },
    );
    await mkdir(join(boardDirectory, "tasks"), { recursive: true });
    await writeFile(
      join(boardDirectory, "config.yml"),
      `version: 11
board:
  name: Sample Board
tasks_dir: tasks
statuses:
  - name: backlog
  - name: todo
  - name: in-progress
  - name: review
  - name: retrospective
  - name: uat
  - name: done
priorities:
  - low
  - medium
  - high
defaults:
  status: backlog
  priority: medium
  class: standard
claim_timeout: 1h
classes:
  - name: standard
tui:
  title_lines: 2
  age_thresholds: []
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
        "todo",
        "--priority",
        "medium",
        "--tags",
        "lifecycle:sample",
        "--json",
      ],
      { cwd: root },
    );
    const taskId = (JSON.parse(created.stdout) as { id: number }).id;
    return {
      blueprintsRepositoryRoot,
      cleanup: () => rm(root, { force: true, recursive: true }),
      repositoryRoot,
      root,
      taskId,
      configuration: {
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
          maxConcurrentSessions: 2,
          providerBudgets: {},
          subagents: { maxDepth: 1, maxFanOut: 1 },
          usageWindowHours: 5,
        },
        products: [
          {
            name: "Sample product",
            repos: [
              {
                name: "sample-repository",
                repositoryRoot,
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
          worktreesRoot: join(root, "worktrees"),
        },
        stageThresholds: { implement: 60_000 },
        stateDirectory,
        stopTimeoutMilliseconds: 1_000,
        t3: { accessToken: "access-token", baseUrl: "http://127.0.0.1:3999" },
      },
    };
  };

export const useMechanicalLifecycle = async (
  fixture: ProductionFixture,
): Promise<void> => {
  await execute(
    "kanban-md",
    [
      "--dir",
      fixture.configuration.boardDirectory,
      "edit",
      String(fixture.taskId),
      "--remove-tag",
      "lifecycle:sample",
      "--add-tag",
      "lifecycle:mechanical",
      "--json",
    ],
    { cwd: fixture.root },
  );
};

export const prepareProductionEpicFixture =
  async (): Promise<ProductionEpicFixture> => {
    const fixture = await prepareProductionFixture();
    await execute(
      "kanban-md",
      [
        "--dir",
        fixture.configuration.boardDirectory,
        "edit",
        String(fixture.taskId),
        "--status",
        "done",
        "--json",
      ],
      { cwd: fixture.root },
    );
    const epic = await execute(
      "kanban-md",
      [
        "--dir",
        fixture.configuration.boardDirectory,
        "create",
        "Sample Delivery",
        "--status",
        "in-progress",
        "--tags",
        "type:epic",
        "--json",
      ],
      { cwd: fixture.root },
    );
    const epicId = (JSON.parse(epic.stdout) as { id: number }).id;
    const child = await execute(
      "kanban-md",
      [
        "--dir",
        fixture.configuration.boardDirectory,
        "create",
        "Arrange sample items",
        "--status",
        "todo",
        "--parent",
        String(epicId),
        "--tags",
        "lifecycle:sample",
        "--json",
      ],
      { cwd: fixture.root },
    );
    return {
      ...fixture,
      epicId,
      taskId: (JSON.parse(child.stdout) as { id: number }).id,
    };
  };
