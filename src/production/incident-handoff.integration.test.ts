// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BoardTask } from "../board-adapter/index.js";
import { GitHandoffTemplateStore } from "../control-plane/index.js";
import { SqlitePersistence } from "../persistence/index.js";
import { DurableAttentionQueue } from "./durable-adapters.js";
import { productionErrorAttention } from "./error-visibility.js";
import {
  incidentAdmissionPolicy,
  ProductionIncidentCoordinator,
} from "./incident-coordinator.js";
import { ProductionInstanceController } from "./instance-controller.js";
import { ProductionLifecycleRouter } from "./lifecycle-router.js";
import { ProductRoutingCatalog } from "./product-routing.js";
import { ProductionConsoleState } from "./console-state.js";
import { SyntheticT3 } from "./composition.test-support.js";
import type { ResolvedProductionConfiguration } from "./configuration.js";
import type { EpicProjectCoordinator } from "./epic-projects.js";

const execute = promisify(execFile);

const incidentTemplate = `---
$schema: https://wyrd.company/heddle/handoff-template.schema.json
relationships:
  implements: heddle
format: heddle.handoff-template
version: 1
kind: standard
---
# Incident {{ handoff.taskContract.incident.incidentId }}

Identity: {{ handoff.taskContract.incident.attentionId }}
Code: {{ handoff.taskContract.incident.code }}
Error: {{ handoff.taskContract.incident.error | stableJson }}
Observations: {{ handoff.taskContract.incident.observations | stableJson }}
Recheck: {{ handoff.taskContract.incident.recheck | stableJson }}
`;

describe("production incident handoff", () => {
  let root = "";
  let persistence: SqlitePersistence | undefined;

  afterEach(async () => {
    persistence?.close();
    persistence = undefined;
    if (root !== "") await rm(root, { force: true, recursive: true });
  });

  it("renders source identity, code, error, observations, and recheck without tokens or configured secrets", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-incident-handoff-"));
    const blueprintsRoot = join(root, "blueprints-repository");
    const repositoryRoot = join(root, "sample-repository");
    await mkdir(join(blueprintsRoot, "blueprints"), { recursive: true });
    await mkdir(join(blueprintsRoot, "handoff-templates"), { recursive: true });
    await mkdir(join(blueprintsRoot, "todo-templates"), { recursive: true });
    await mkdir(repositoryRoot, { recursive: true });
    await writeFile(join(repositoryRoot, "README.md"), "# Fixture\n");
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
        "Add fixture repository",
      ],
      { cwd: repositoryRoot },
    );
    await writeFile(
      join(blueprintsRoot, "handoff-templates", "incident.md"),
      incidentTemplate,
    );
    await writeFile(
      join(blueprintsRoot, "todo-templates", "incident.json"),
      JSON.stringify({ items: [{ id: "diagnose", text: "Diagnose" }] }),
    );
    await execute("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: blueprintsRoot,
    });
    await execute("git", ["add", "."], { cwd: blueprintsRoot });
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
        "Add incident fixture template",
      ],
      { cwd: blueprintsRoot },
    );
    const templateCommit = (
      await execute("git", ["rev-parse", "HEAD"], { cwd: blueprintsRoot })
    ).stdout.trim();
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
            target: "closed",
          },
        ],
        nodes: [
          { id: "begin", uses: "complete" },
          {
            handoff: "standard",
            "handoff-template": {
              commitSha: templateCommit,
              path: "handoff-templates/incident.md",
            },
            id: "implement",
            "todo-template": "incident",
            tools: ["advance"],
            uses: "wait",
          },
          { id: "closed", uses: "complete" },
        ],
      }),
    );
    await execute("git", ["add", "."], { cwd: blueprintsRoot });
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
        "Add incident fixture blueprint",
      ],
      { cwd: blueprintsRoot },
    );
    persistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    const correlationToken = "correlation-fixture-secret";
    persistence.createInstance("sample-source", {
      correlationTokens: { "sample-session": correlationToken },
      flowcraftContext: {
        awaitingNodeIds: ["sample-stage"],
        blueprintBlobHash: "0123456789012345678901234567890123456789",
        blueprintPath: "blueprints/sample.json",
        completedOperations: {},
        executionIds: ["sample-execution"],
        nextTransitionNumber: 2,
        pendingAttentions: [],
        pendingTransition: null,
        serializedContext: "{}",
        status: "awaiting",
      },
      handoffs: [],
      todoState: null,
    });
    persistence.writeReconcilerRuntime({
      boardStatus: "in-progress",
      instanceId: "sample-source",
      state: "waiting",
      taskId: 17,
    });
    const configuredSecret = "configured-fixture-secret";
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
    const routing = new ProductRoutingCatalog(configuration);
    const boardTask: BoardTask = {
      blocked: false,
      dependencies: [],
      frontMatter: {},
      id: 17,
      priority: "medium",
      status: "in-progress",
      tags: [],
      title: "Arrange inventory",
    };
    routing.update([boardTask]);
    const lifecycle = new ProductionLifecycleRouter({
      effects: { complete: async () => ({}) },
      persistence,
      repositoryRoot: blueprintsRoot,
      sourceRef: "HEAD",
    });
    const attention = new DurableAttentionQueue(persistence, undefined, [
      configuredSecret,
    ]);
    const t3 = new SyntheticT3();
    const controller = new ProductionInstanceController(
      configuration,
      persistence,
      lifecycle,
      routing,
      {
        projectForTask: () => "sample-project",
      } as EpicProjectCoordinator,
      attention,
      t3,
      "http://127.0.0.1:4774/mcp",
      async () => "System prompt",
      {
        readHandoffTemplate: (reference, skills) =>
          new GitHandoffTemplateStore(blueprintsRoot).read(reference, skills),
        repositoryRoot: blueprintsRoot,
      },
      undefined,
      vi.fn(async () => undefined),
    );
    const coordinator = new ProductionIncidentCoordinator(
      persistence,
      attention,
      lifecycle,
      controller,
      {
        admissionPolicy: { ...incidentAdmissionPolicy, failureThreshold: 1 },
        secrets: [configuredSecret],
      },
    );
    const source = productionErrorAttention({
      code: "task-reconciliation-failed",
      error: new Error(
        `Synthetic failure ${correlationToken} ${configuredSecret} https://actor:password@host.invalid/repository`,
      ),
      instanceId: "sample-source",
      summary: "Production condition",
      taskId: boardTask.id,
    });
    await attention.raise(source);

    await coordinator.reconcile([boardTask]);

    const incident = persistence.listIncidentRuntime()[0]!;
    expect(incident).toMatchObject({ stageId: "implement", state: "waiting" });
    const session = persistence
      .listSessionRuntime()
      .find(({ instanceId }) => instanceId === incident.incidentId)!;
    expect(session.binding.providerInstanceId).toBe("codex");
    expect(session.binding.sessionKey).toBe(session.sessionKey);
    expect(session.binding.threadId).toBe(session.threadId);
    const record = persistence.getInstance(incident.incidentId)!;
    const serialized = JSON.stringify(record.state.handoffs);
    expect(serialized).toContain(source.attentionId);
    expect(serialized).toContain("task-reconciliation-failed");
    expect(serialized).toContain("Synthetic failure");
    expect(serialized).toContain("sourceInstanceId");
    expect(serialized).toContain("Observe the source condition again");
    expect(serialized).not.toContain(correlationToken);
    expect(serialized).not.toContain(configuredSecret);
    expect(serialized).not.toContain("password");
    expect(t3.mcpRegistrations).toHaveLength(1);
    const consoleState = new ProductionConsoleState(
      persistence,
      attention,
      blueprintsRoot,
      "HEAD",
    );
    const projected = await consoleState.listAttention();
    expect(projected[0]).toMatchObject({
      attentionId: source.attentionId,
      incidentId: incident.incidentId,
      taskId: boardTask.id,
    });
    const lifecycleSnapshot = await consoleState.readLifecycle({
      afterSequence: 0,
      instanceId: incident.incidentId,
      taskId: boardTask.id,
    });
    expect(lifecycleSnapshot).toMatchObject({
      blueprint: { id: "incident" },
      currentStageIds: ["implement"],
      instanceId: incident.incidentId,
      taskId: boardTask.id,
    });
    expect(JSON.stringify(persistence.listAttention())).not.toContain(
      configuredSecret,
    );
    expect(
      await readFile(
        join(blueprintsRoot, "blueprints", "incident.json"),
        "utf8",
      ),
    ).toContain(templateCommit);
  });
});
