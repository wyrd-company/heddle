// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import type { BoardTask } from "../board-adapter/index.js";
import {
  GitHandoffTemplateStore,
  type SessionT3Client,
} from "../control-plane/index.js";
import type { T3DispatchCommand } from "../control-plane/t3-control-plane-client.js";
import { SqlitePersistence } from "../persistence/index.js";
import type { ResolvedProductionConfiguration } from "./configuration.js";
import { DurableAttentionQueue } from "./durable-adapters.js";
import { productionErrorAttention } from "./error-visibility.js";
import {
  incidentAdmissionPolicy,
  ProductionIncidentCoordinator,
} from "./incident-coordinator.js";
import { ProductionInstanceController } from "./instance-controller.js";
import { ProductionLifecycleRouter } from "./lifecycle-router.js";
import { ProductRoutingCatalog } from "./product-routing.js";
import type { EpicProjectCoordinator } from "./epic-projects.js";

const execute = promisify(execFile);
const [mode, root] = process.argv.slice(2);
if ((mode !== "crash" && mode !== "resume") || root === undefined) {
  throw new Error("mode and fixture root are required");
}

const blueprintsRoot = join(root, "blueprint-repository");
const repositoryRoot = join(root, "sample-repository");
const commandLog = join(root, "commands.jsonl");
const issueLog = join(root, "issue-attempts.jsonl");

const initializeRepositories = async (): Promise<void> => {
  if (
    await access(join(blueprintsRoot, ".git")).then(
      () => true,
      () => false,
    )
  ) {
    return;
  }
  await mkdir(join(blueprintsRoot, "blueprints"), { recursive: true });
  await mkdir(join(blueprintsRoot, "handoff-templates"), { recursive: true });
  await mkdir(join(blueprintsRoot, "todo-templates"), { recursive: true });
  await mkdir(repositoryRoot, { recursive: true });
  await writeFile(join(repositoryRoot, "README.md"), "# Sample repository\n");
  await execute("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: repositoryRoot,
  });
  await execute("git", ["add", "README.md"], { cwd: repositoryRoot });
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
      "Add sample repository",
    ],
    { cwd: repositoryRoot },
  );
  await writeFile(
    join(blueprintsRoot, "handoff-templates", "incident.md"),
    `---
$schema: https://wyrd.company/heddle/handoff-template.schema.json
relationships:
  implements: heddle
format: heddle.handoff-template
version: 1
kind: standard
---
# Incident {{ handoff.taskContract.incident.incidentId }}

Stage {{ handoff.stage.name }}
`,
  );
  for (const stage of ["implement", "review", "finalize"]) {
    await writeFile(
      join(blueprintsRoot, "todo-templates", `incident-${stage}.json`),
      JSON.stringify({ items: [{ id: "act", text: `Act at ${stage}` }] }),
    );
  }
  await execute("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: blueprintsRoot,
  });
  await execute("git", ["add", "handoff-templates", "todo-templates"], {
    cwd: blueprintsRoot,
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
      "Add incident templates",
    ],
    { cwd: blueprintsRoot },
  );
  const templateCommit = (
    await execute("git", ["rev-parse", "HEAD"], { cwd: blueprintsRoot })
  ).stdout.trim();
  const wait = (id: string) => ({
    ...(id === "implement" || id === "review"
      ? { config: { joinStrategy: "any" } }
      : {}),
    handoff: "standard",
    "handoff-template": {
      commitSha: templateCommit,
      path: "handoff-templates/incident.md",
    },
    id,
    "todo-template": `incident-${id}`,
    tools: ["advance"],
    uses: "wait",
  });
  await writeFile(
    join(blueprintsRoot, "blueprints", "incident.json"),
    JSON.stringify({
      edges: [
        { source: "begin", target: "implement" },
        {
          condition: "result.output.dispositions.diagnosed",
          description: "Submit diagnosis",
          disposition: "diagnosed",
          source: "implement",
          target: "review",
        },
        {
          condition: "result.output.dispositions.reject",
          description: "Return diagnosis",
          disposition: "reject",
          source: "review",
          target: "implement",
        },
        {
          condition: "result.output.dispositions.approve",
          description: "Accept diagnosis",
          disposition: "approve",
          source: "review",
          target: "finalize",
        },
        {
          condition: "result.output.dispositions.complete",
          description: "Complete actions",
          disposition: "complete",
          source: "finalize",
          target: "closed",
        },
      ],
      nodes: [
        { id: "begin", uses: "complete" },
        wait("implement"),
        wait("review"),
        wait("finalize"),
        { id: "closed", uses: "complete" },
      ],
    }),
  );
  await execute("git", ["add", "blueprints"], { cwd: blueprintsRoot });
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
      "Add incident graph",
    ],
    { cwd: blueprintsRoot },
  );
};

await initializeRepositories();
const recorded = (await readFile(commandLog, "utf8").catch(() => ""))
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as T3DispatchCommand);
const seen = new Set(recorded.map(({ commandId }) => commandId));
const turnText = (command: T3DispatchCommand): string | undefined => {
  const message = command["message"];
  return typeof message === "object" &&
    message !== null &&
    !Array.isArray(message) &&
    typeof (message as Record<string, unknown>)["text"] === "string"
    ? ((message as Record<string, unknown>)["text"] as string)
    : undefined;
};
const t3: SessionT3Client = {
  dispatch: async (command) => {
    const firstAttempt = !seen.has(command.commandId);
    if (firstAttempt) {
      seen.add(command.commandId);
      recorded.push(command);
      await appendFile(commandLog, `${JSON.stringify(command)}\n`);
    }
    const text = turnText(command);
    if (firstAttempt && text?.includes("Stage finalize")) {
      const incidentId = /# Incident (incident:[a-f0-9]+)/u.exec(text)?.[1];
      if (incidentId === undefined) {
        throw new Error("Finalizer handoff has no incident identity");
      }
      await execute(join(root, "bin", "gh"), [
        "issue",
        "create",
        "--title",
        "Record production incident",
        "--body",
        `Incident: ${incidentId}`,
      ]);
      if (mode === "crash") process.exit(86);
    }
    return { sequence: recorded.length };
  },
  registerWorkflowMcpProviderSession: async () => undefined,
};

const configuration = {
  adHocProject: {
    name: "Shared tasks",
    projectId: "sample-project",
    workspaceRoot: root,
  },
  products: [
    {
      name: "Sample product",
      repos: [{ name: "sample-repository", repositoryRoot }],
    },
  ],
  session: {
    baseRef: "main",
    defaultProviderAlias: "primary",
    defaultRuntimeMode: "auto-accept-edits" as const,
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
      runtimeMode: "auto-accept-edits" as const,
    },
    interactionMode: "default",
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
        runtimeMode: "auto-accept-edits" as const,
      },
    ],
    skillPointer: "skill://sample",
    worktreesRoot: join(root, "worktrees"),
  },
} as unknown as ResolvedProductionConfiguration;
const task: BoardTask = {
  blocked: false,
  dependencies: [],
  frontMatter: {},
  id: 17,
  priority: "medium",
  status: "in-progress",
  tags: [],
  title: "Arrange inventory",
};
const persistence = new SqlitePersistence({
  stateDirectory: join(root, "state"),
});
const attention = new DurableAttentionQueue(persistence);
const routing = new ProductRoutingCatalog(configuration);
routing.update([task]);
const lifecycle = new ProductionLifecycleRouter({
  effects: { complete: async () => ({}) },
  persistence,
  repositoryRoot: blueprintsRoot,
  sourceRef: "HEAD",
});
const controller = new ProductionInstanceController(
  configuration,
  persistence,
  lifecycle,
  routing,
  {
    projectForTask: () => "sample-project",
  } as unknown as EpicProjectCoordinator,
  attention,
  t3,
  "http://127.0.0.1:4774/mcp",
  async () => "System prompt",
  {
    readHandoffTemplate: (reference, skills) =>
      new GitHandoffTemplateStore(blueprintsRoot).read(reference, skills),
    repositoryRoot: blueprintsRoot,
  },
);
const coordinator = new ProductionIncidentCoordinator(
  persistence,
  attention,
  lifecycle,
  controller,
  {
    admissionPolicy: { ...incidentAdmissionPolicy, failureThreshold: 1 },
  },
);

if (mode === "crash") {
  const source = productionErrorAttention({
    code: "task-reconciliation-failed",
    error: new Error("Synthetic production condition"),
    instanceId: "sample-source",
    summary: "Production condition",
    taskId: task.id,
  });
  await attention.raise(source);
  await coordinator.reconcile([task]);
  if (persistence.getInstance(source.incidentId!) === undefined) {
    throw new Error(
      `Incident start failed: ${JSON.stringify(persistence.listAttention())}`,
    );
  }
  if (persistence.listIncidentRuntime()[0]?.state === "failed") {
    throw new Error(
      `Incident activation failed: ${JSON.stringify(persistence.listAttention())}`,
    );
  }
  await coordinator.resume({
    disposition: "diagnosed",
    instanceId: source.incidentId!,
    operationId: "diagnose-once",
    output: {
      conditionState: "live",
      proposedActions: [{ kind: "github-issue", summary: "Record it" }],
      rootCauseAnalysis: "Synthetic analysis",
    },
  });
  await coordinator.resume({
    disposition: "approve",
    instanceId: source.incidentId!,
    operationId: "approve-once",
  });
  throw new Error("Expected process termination after issue attempt");
}

await coordinator.reconcile([task]);
const finalizeSessions = persistence
  .listSessionRuntime()
  .filter(({ stageId }) => stageId === "finalize");
const issueAttempts = (await readFile(issueLog, "utf8"))
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as string[]);
process.stdout.write(
  JSON.stringify({
    finalizeSessions: finalizeSessions.map(
      ({ activation, sessionKey, threadId }) => ({
        activation,
        sessionKey,
        threadId,
      }),
    ),
    issueAttempts,
    runtime: persistence.listIncidentRuntime()[0],
  }),
);
persistence.close();
