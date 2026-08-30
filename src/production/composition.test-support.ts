// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type {
  HarnessToolTimeoutLaunchInput,
  T3DispatchCommand,
} from "../control-plane/index.js";
import type { ProductionConfiguration } from "./configuration.js";
import type { ProductionT3Client } from "./composition.js";

export const execute = promisify(execFile);

export class SyntheticT3 implements ProductionT3Client {
  readonly approvalResponses: Array<{
    decision: "accept" | "reject";
    commandId?: string;
    requestId: string;
    threadId: string;
  }> = [];
  readonly commands: T3DispatchCommand[] = [];
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
  cleanup(): Promise<void>;
  configuration: ProductionConfiguration;
  root: string;
  taskId: number;
};

export const prepareProductionFixture =
  async (): Promise<ProductionFixture> => {
    const root = await mkdtemp(join(tmpdir(), "heddle-production-"));
    const repositoryRoot = join(root, "sample-repository");
    const boardDirectory = join(root, "sample-board");
    const stateDirectory = join(root, "state");
    await mkdir(join(repositoryRoot, "blueprints"), { recursive: true });
    await mkdir(join(repositoryRoot, "todo-templates"), { recursive: true });
    await writeFile(
      join(repositoryRoot, "blueprints", "sample.json"),
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
            id: "implement",
            tools: ["advance", "answer", "liveness", "spawn"],
            "todo-template": "sample-stage",
            uses: "wait",
          },
          {
            id: "review",
            handoff: "standard",
            config: { joinStrategy: "any" },
            tools: ["advance", "answer", "liveness", "spawn"],
            "todo-template": "sample-stage",
            uses: "wait",
          },
          {
            id: "remediate",
            handoff: "remediation",
            config: { joinStrategy: "any" },
            tools: ["advance", "answer", "liveness", "spawn"],
            "todo-template": "sample-stage",
            uses: "wait",
          },
          { id: "finalize", uses: "finalize" },
        ],
      }),
    );
    await writeFile(
      join(repositoryRoot, "todo-templates", "sample-stage.json"),
      JSON.stringify({
        items: [{ id: "deliver", text: "Deliver the sample" }],
      }),
    );
    await execute("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: repositoryRoot,
    });
    await execute("git", ["add", "blueprints", "todo-templates"], {
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
      cleanup: () => rm(root, { force: true, recursive: true }),
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
