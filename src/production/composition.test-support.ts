// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { KanbanBoardStore } from "../board-store/index.js";
import { writeTaskFile } from "../board-store/task-file.js";
import type {
  T3DispatchCommand,
  T3ProviderDispatchContext,
  T3WorkflowMcpProviderSession,
  T3ProviderCatalogEntry,
  T3ProviderCatalogModel,
} from "../control-plane/index.js";
import type { T3ThreadActivity } from "../control-plane/t3-control-plane-client.js";
import type { ResolvedProductionConfiguration } from "./configuration.js";
import type { ProductionT3Client } from "./composition.js";

export const execute = promisify(execFile);

export interface BoardTaskFixture {
  dependsOn?: number[];
  parent?: number;
  priority?: string;
  repos?: string[];
  status?: string;
  tags?: string[];
  title: string;
}

/**
 * Authors a board task through Heddle's own board layer. Repository scope is
 * ordinary front matter here, so a qualification board needs no kanban-md —
 * forked or otherwise — on PATH.
 */
export const createBoardTask = async (
  boardDirectory: string,
  fixture: BoardTaskFixture,
): Promise<number> => {
  const { repos, ...rest } = fixture;
  const created = await new KanbanBoardStore(boardDirectory).createTask({
    ...rest,
    ...(repos === undefined ? {} : { properties: { repos } }),
  });
  return created.id;
};

/**
 * Inserts a raw declaration at the end of a task file's front matter, so a
 * fixture can author a property the board layer would refuse to build. The
 * anchor is the front-matter terminator rather than any particular property,
 * because a task file's last property is not fixed.
 */
export const declareTaskFileProperty = async (
  taskPath: string,
  declaration: string,
): Promise<void> => {
  const source = await readFile(taskPath, "utf8");
  const end = source.indexOf("\n---\n", "---\n".length);
  if (end === -1) {
    throw new Error(`task file has no front matter: ${taskPath}`);
  }
  const written = `${source.slice(0, end)}\n${declaration}${source.slice(end)}`;
  await writeFile(taskPath, written);
  // A fixture that silently declares nothing tests nothing.
  if (!written.includes(declaration)) {
    throw new Error(`declaration did not land in ${taskPath}`);
  }
};

/** Removes the repository scope a board task declares. */
export const clearBoardTaskRepositories = async (
  boardDirectory: string,
  taskId: number,
): Promise<void> => {
  const task = await new KanbanBoardStore(boardDirectory).readTask(taskId);
  task.document.frontMatter.delete("repos");
  await writeTaskFile(task);
};

/**
 * Authors a board task from a kanban-md-shaped flag list, for fixtures that
 * build several tasks from one list.
 */
export const createBoardTaskFromFlags = async (
  boardDirectory: string,
  flags: string[],
): Promise<number> => {
  const [title, ...rest] = flags;
  const fixture: BoardTaskFixture = { title: title! };
  for (let index = 0; index < rest.length; index += 2) {
    const value = rest[index + 1]!;
    switch (rest[index]) {
      case "--status":
        fixture.status = value;
        break;
      case "--priority":
        fixture.priority = value;
        break;
      case "--parent":
        fixture.parent = Number(value);
        break;
      case "--depends-on":
        fixture.dependsOn = value.split(",").map(Number);
        break;
      case "--tags":
        fixture.tags = value.split(",");
        break;
      case "--repos":
        fixture.repos = value.split(",");
        break;
      default:
        throw new Error(`unsupported board fixture flag: ${rest[index]}`);
    }
  }
  return createBoardTask(boardDirectory, fixture);
};

/** Replaces the repository scope a board task declares. */
export const setBoardTaskRepositories = async (
  boardDirectory: string,
  taskId: number,
  repos: string[],
): Promise<void> => {
  const task = await new KanbanBoardStore(boardDirectory).readTask(taskId);
  task.document.frontMatter.set("repos", repos);
  await writeTaskFile(task);
};

const standardHandoffTemplate = `---
$schema: https://wyrd.company/heddle/handoff-template.schema.json
relationships:
  implements: heddle
format: heddle.handoff-template
kind: standard
version: 1
---
# {{ task.title }}

Stage: {{ handoff.stage.name }}

Repositories: {{ task.repos | stableJson }}

Prior outputs: {{ handoff.stage.priorStageOutputs | stableJson }}

{% for list in handoff.todoList.lists %}{% for item in list.items %}- [{% if item.checked %}x{% else %} {% endif %}] {{ item.text }}
{% endfor %}{% endfor %}`;

const remediationHandoffTemplate = `---
$schema: https://wyrd.company/heddle/handoff-template.schema.json
relationships:
  implements: heddle
format: heddle.handoff-template
kind: remediation
version: 1
---
# {{ task.title }}

Stage: {{ handoff.stage.name }}

{% set cause = handoff.stage.entry.output.remediationCause %}
{% if cause and cause.kind == "review-basis-drift" %}
The reviewed basis changed before merge.
{% elif cause and cause.kind == "review-source-behind" %}
The reviewed source did not contain the target when the review snapshot was captured.
{% endif %}
{% if cause and (cause.kind == "review-basis-drift" or cause.kind == "review-source-behind") %}
Rebase source branch {{ cause.sourceBranch }} at {{ cause.currentSourceHead }} onto target branch {{ cause.targetBranch }} at exact head {{ cause.currentTargetHead }} without creating a merge commit. Preserve task-scoped changes, resolve conflicts, validate, commit only task-scoped changes, verify the exact target head is an ancestor of the current source HEAD, and verify the worktree is clean before calling advance.
{% endif %}

Entry: {{ handoff.stage.entry.node }} {{ handoff.stage.entry.output | stableJson }}

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
  /** Activities returned by {@link getThread}, keyed by thread id. */
  readonly threadActivities = new Map<string, T3ThreadActivity[]>();
  /** Resolutions the reactor has accepted but not yet ingested. */
  readonly pendingResolutions: Array<() => void> = [];
  readonly dispatches: Array<{
    command: T3DispatchCommand;
    providerContext?: T3ProviderDispatchContext;
  }> = [];
  readonly providerContexts: T3ProviderDispatchContext[] = [];
  readonly mcpRegistrations: T3WorkflowMcpProviderSession[] = [];
  readonly projects = new Map<
    string,
    { createdAt: string; id: string; title: string; workspaceRoot: string }
  >();
  readonly providerCatalog: Array<
    Omit<T3ProviderCatalogEntry, "models"> & {
      models: T3ProviderCatalogModel[];
    }
  > = [
    {
      availability: "available",
      displayName: "Workbench Alpha",
      driverKind: "codex",
      enabled: true,
      installed: true,
      instanceId: "codex",
      models: [
        {
          isCustom: false,
          name: "Sample Model",
          slug: "sample-model",
        },
      ],
      observedCliVersion: "0.91.0",
      state: "ready",
    },
  ];
  readonly threads = new Set<string>();
  readonly userInputResponses: Array<{
    answers: Record<string, string | string[]>;
    commandId?: string;
    requestId: string;
    threadId: string;
  }> = [];

  async dispatch(
    command: T3DispatchCommand,
    providerContext?: T3ProviderDispatchContext,
  ): Promise<{ sequence: number }> {
    const storedCommand = globalThis.structuredClone(command);
    this.commands.push(storedCommand);
    this.dispatches.push({
      command: storedCommand,
      ...(providerContext === undefined
        ? {}
        : { providerContext: globalThis.structuredClone(providerContext) }),
    });
    if (providerContext !== undefined) {
      this.providerContexts.push(globalThis.structuredClone(providerContext));
    }
    if (
      command.type === "project.create" &&
      typeof command.projectId === "string" &&
      typeof command.title === "string" &&
      typeof command.workspaceRoot === "string" &&
      typeof command.createdAt === "string"
    ) {
      this.projects.set(command.projectId, {
        createdAt: command.createdAt,
        id: command.projectId,
        title: command.title,
        workspaceRoot: command.workspaceRoot,
      });
    }
    if (
      command.type === "project.meta.update" &&
      typeof command.projectId === "string" &&
      typeof command.title === "string"
    ) {
      const project = this.projects.get(command.projectId);
      if (project !== undefined) {
        this.projects.set(command.projectId, {
          ...project,
          title: command.title,
        });
      }
    }
    if (command.type === "thread.create" && command.threadId !== undefined) {
      this.threads.add(command.threadId);
    }
    return { sequence: this.commands.length };
  }

  async getShell() {
    return {
      projects: [...this.projects.values()].map((project) => ({ ...project })),
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

  /** Runs the reactor, so accepted responses become recorded resolutions. */
  settleProviderResponses(): void {
    const queued = this.pendingResolutions.splice(0);
    for (const resolve of queued) resolve();
  }

  async getThread(threadId?: string) {
    return {
      thread: {
        activities: [...(this.threadActivities.get(threadId ?? "") ?? [])],
      },
    };
  }

  async readProviderCatalog() {
    return globalThis.structuredClone(this.providerCatalog);
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
    // T3 accepts the response and a separate reactor delivers it to the
    // provider, so the resolution appears on a later read, never before this
    // dispatch returns.
    const activities = this.threadActivities.get(threadId);
    if (activities !== undefined) {
      this.pendingResolutions.push(() => {
        activities.push({ kind: "approval.resolved", payload: { requestId } });
      });
    }
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
  configuration: ResolvedProductionConfiguration;
  repositoryRoot: string;
  root: string;
  taskId: number;
};

export type ProductionEpicFixture = ProductionFixture & { epicId: number };

export const prepareProductionFixture =
  async (): Promise<ProductionFixture> => {
    const root = await mkdtemp(join(tmpdir(), "heddle-production-"));
    const repositoryRoot = join(root, "tools", "sample-repository");
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
    await mkdir(join(blueprintsRepositoryRoot, "themes"), {
      recursive: true,
    });
    await mkdir(join(blueprintsRepositoryRoot, "adjudication"), {
      recursive: true,
    });
    await mkdir(join(blueprintsRepositoryRoot, "output-contracts"), {
      recursive: true,
    });
    await writeFile(
      join(
        blueprintsRepositoryRoot,
        "output-contracts",
        "implementation-evidence.json",
      ),
      `${JSON.stringify(
        { properties: { evidence: { type: "string" } }, type: "object" },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(
        blueprintsRepositoryRoot,
        "output-contracts",
        "review-findings.json",
      ),
      `${JSON.stringify(
        {
          properties: { findings: { minItems: 1, type: "array" } },
          required: ["findings"],
          type: "object",
        },
        null,
        2,
      )}\n`,
    );
    await mkdir(repositoryRoot, { recursive: true });
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
    await writeFile(
      join(blueprintsRepositoryRoot, "themes", "sample-team.yml"),
      `$schema: https://wyrd.company/heddle/agent-name-theme.schema.json
relationships:
  implements: heddle
kind: team
leader: sample-lead
companions: [sample-companion]
allies: [sample-ally]
antagonists: [sample-antagonist]
neutrals: [sample-neutral]
`,
    );
    await writeFile(
      join(blueprintsRepositoryRoot, "themes", "sample-soloist.yml"),
      `$schema: https://wyrd.company/heddle/agent-name-theme.schema.json
relationships:
  implements: heddle
kind: soloist
heroes: [sample-hero]
villains: [sample-villain]
bystanders: [sample-bystander]
`,
    );
    await writeFile(
      join(blueprintsRepositoryRoot, "adjudication", "policy.json"),
      JSON.stringify({
        $schema: "https://wyrd.company/heddle/adjudication-policy.schema.json",
        relationships: { implements: "heddle" },
        "decision-boundary": {
          decide: ["Decide reversible implementation details."],
          escalate: ["Escalate material product decisions."],
          test: "Who outside this sample would break?",
        },
      }),
    );
    await execute("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: blueprintsRepositoryRoot,
    });
    await execute(
      "git",
      [
        "add",
        "adjudication",
        "handoff-templates",
        "output-contracts",
        "todo-templates",
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
    const templateCommitSha = (
      await execute("git", ["rev-parse", "HEAD"], {
        cwd: blueprintsRepositoryRoot,
      })
    ).stdout.trim();
    await writeFile(
      join(blueprintsRepositoryRoot, "blueprints", "sample.json"),
      JSON.stringify({
        $schema: "https://wyrd.company/heddle/lifecycle-blueprint.schema.json",
        "board-statuses": {
          finalize: "done",
          "prepare-worktree": "in-progress",
        },
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
            "output-contract": "implementation-evidence",
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
            "handoff-template": {
              commitSha: templateCommitSha,
              kind: "standard",
              path: "handoff-templates/standard.md",
            },
            id: "implement",
            tools: [
              "advance",
              "answer",
              "create_finding",
              "create_follow_up",
              "list_providers",
              "liveness",
              "spawn",
            ],
            "todo-template": "sample-stage",
            uses: "wait",
          },
          {
            id: "review",
            "handoff-template": {
              commitSha: templateCommitSha,
              kind: "standard",
              path: "handoff-templates/standard.md",
            },
            config: { joinStrategy: "any" },
            tools: [
              "advance",
              "answer",
              "create_finding",
              "create_follow_up",
              "list_providers",
              "liveness",
              "spawn",
            ],
            "todo-template": "sample-stage",
            uses: "wait",
          },
          {
            id: "remediate",
            "handoff-template": {
              commitSha: templateCommitSha,
              kind: "remediation",
              path: "handoff-templates/remediation.md",
            },
            config: { joinStrategy: "any" },
            tools: [
              "advance",
              "answer",
              "create_finding",
              "create_follow_up",
              "list_providers",
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
        "board-statuses": {
          finalize: "done",
          "prepare-worktree": "in-progress",
        },
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
            "handoff-template": {
              commitSha: templateCommitSha,
              kind: "standard",
              path: "handoff-templates/standard.md",
            },
            id: "implement",
            repo: "sample-repository",
            tools: [
              "advance",
              "answer",
              "create_finding",
              "create_follow_up",
              "list_providers",
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
    // Repository scope is written by Heddle's own board layer, so building a
    // qualification board needs no forked kanban-md on PATH.
    const created = await new KanbanBoardStore(boardDirectory).createTask({
      priority: "medium",
      properties: { repos: ["sample-repository"] },
      status: "todo",
      tags: ["lifecycle:sample"],
      title: "Example Item",
    });
    const taskId = created.id;
    return {
      blueprintsRepositoryRoot,
      cleanup: () => rm(root, { force: true, recursive: true }),
      repositoryRoot,
      root,
      taskId,
      configuration: {
        adHocProject: {
          label: "Sample worker",
          workspaceRoot: root,
        },
        boardDirectory,
        cadenceMilliseconds: 60_000,
        incident: {
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
          maxConcurrentSessions: 2,
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
        pushover: {
          apiUrl: "https://notify.invalid/messages",
          applicationToken: "application-token",
          consoleBaseUrl: "https://console.invalid/",
          recipientLabel: "Primary operator",
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
    const epic = await new KanbanBoardStore(
      fixture.configuration.boardDirectory,
    ).createTask({
      properties: { repos: ["sample-repository"] },
      status: "in-progress",
      tags: ["type:epic"],
      title: "Sample Delivery",
    });
    const epicId = epic.id;
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
