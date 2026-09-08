// ---
// relationships:
//   verifies: heddle
// ---

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createProductionComposition } from "./composition.js";
import {
  execute,
  prepareProductionFixture,
  SyntheticT3,
  type ProductionFixture,
} from "./composition.test-support.js";
import { productionErrorAttention } from "./error-visibility.js";

const workflowMcpEndpoint = "http://127.0.0.1:4774/mcp";

describe("production incident provider selection", () => {
  let close: (() => Promise<void>) | undefined;
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
    await cleanup?.();
    cleanup = undefined;
  });

  const prepare = async (input: { stageAlias: string; taskAlias?: string }) => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    fixture.configuration.providerAliases["incident-stage"] = {
      model: "sample-stage-model",
      providerDisplayName: "Sample Stage Workbench",
    };
    fixture.configuration.providerAliases["incident-task"] = {
      model: "sample-task-model",
      providerDisplayName: "Sample Task Workbench",
    };
    fixture.configuration.session.resolvedSelections.push(
      {
        alias: "incident-stage",
        driverKind: "cursor",
        interactionMode: "default",
        model: {
          isCustom: false,
          name: "Sample Stage Model",
          slug: "sample-stage-model",
        },
        observedCliVersion: "sample-stage-version",
        providerDisplayName: "Sample Stage Workbench",
        providerInstanceId: "incident-stage-provider",
        runtimeMode: "auto-accept-edits",
      },
      {
        alias: "incident-task",
        driverKind: "codex",
        interactionMode: "default",
        model: {
          isCustom: false,
          name: "Sample Task Model",
          slug: "sample-task-model",
        },
        observedCliVersion: "sample-task-version",
        providerDisplayName: "Sample Task Workbench",
        providerInstanceId: "incident-task-provider",
        runtimeMode: "auto-accept-edits",
      },
    );
    await writeFile(
      join(fixture.blueprintsRepositoryRoot, "handoff-templates/incident.md"),
      `---
$schema: https://wyrd.company/heddle/handoff-template.schema.json
relationships:
  implements: heddle
format: heddle.handoff-template
version: 1
kind: standard
---
# Incident {{ handoff.taskContract.incident.incidentId }}
`,
    );
    await execute("git", ["add", "handoff-templates/incident.md"], {
      cwd: fixture.blueprintsRepositoryRoot,
    });
    await execute(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@invalid",
        "commit",
        "--quiet",
        "-m",
        "Add sample incident handoff",
      ],
      { cwd: fixture.blueprintsRepositoryRoot },
    );
    const templateCommit = (
      await execute("git", ["rev-parse", "HEAD"], {
        cwd: fixture.blueprintsRepositoryRoot,
      })
    ).stdout.trim();
    await writeFile(
      join(fixture.blueprintsRepositoryRoot, "blueprints/incident.json"),
      `${JSON.stringify(
        {
          $schema:
            "https://wyrd.company/heddle/lifecycle-blueprint.schema.json",
          relationships: { implements: "heddle", uses: ["sample-stage"] },
          edges: [
            { source: "begin", target: "implement" },
            {
              condition: "result.output.dispositions.diagnosed",
              description: "Submit the sample diagnosis",
              disposition: "diagnosed",
              source: "implement",
              target: "review",
            },
            {
              condition: "result.output.dispositions.reject",
              description: "Revise the sample diagnosis",
              disposition: "reject",
              source: "review",
              target: "implement",
            },
            {
              condition: "result.output.dispositions.approve",
              description: "Approve the sample diagnosis",
              disposition: "approve",
              source: "review",
              target: "finalize",
            },
            {
              condition: "result.output.dispositions.complete",
              description: "Complete the sample incident",
              disposition: "complete",
              source: "finalize",
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
              "provider-alias": input.stageAlias,
              "runtime-mode": "full-access",
              "todo-template": "sample-stage",
              tools: ["advance"],
              uses: "wait",
              config: { joinStrategy: "any" },
            },
            {
              handoff: "standard",
              "handoff-template": {
                commitSha: templateCommit,
                path: "handoff-templates/incident.md",
              },
              id: "review",
              "todo-template": "sample-stage",
              tools: ["advance"],
              uses: "wait",
              config: { joinStrategy: "any" },
            },
            {
              handoff: "standard",
              "handoff-template": {
                commitSha: templateCommit,
                path: "handoff-templates/incident.md",
              },
              id: "finalize",
              "todo-template": "sample-stage",
              tools: ["advance"],
              uses: "wait",
            },
            { id: "closed", uses: "complete" },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await execute("git", ["add", "blueprints/incident.json"], {
      cwd: fixture.blueprintsRepositoryRoot,
    });
    await execute(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@invalid",
        "commit",
        "--quiet",
        "-m",
        "Add sample incident selection",
      ],
      { cwd: fixture.blueprintsRepositoryRoot },
    );
    await execute("git", ["push", "--quiet"], {
      cwd: fixture.blueprintsRepositoryRoot,
    });
    if (input.taskAlias !== undefined) {
      const [taskFilename] = await readdir(
        join(fixture.configuration.boardDirectory, "tasks"),
      );
      const taskPath = join(
        fixture.configuration.boardDirectory,
        "tasks",
        taskFilename!,
      );
      await writeFile(
        taskPath,
        (await readFile(taskPath, "utf8")).replace(
          "class: standard\n---",
          `class: standard\nprovider-alias: ${input.taskAlias}\n---`,
        ),
      );
    }
    await execute(
      "kanban-md",
      [
        "--dir",
        fixture.configuration.boardDirectory,
        "edit",
        String(fixture.taskId),
        "--block",
        "Waiting for a sample fixture",
        "--json",
      ],
      { cwd: fixture.root },
    );
    const t3 = new SyntheticT3();
    t3.providerCatalog.push(
      {
        availability: "available",
        displayName: "Sample Stage Workbench",
        driverKind: "cursor",
        enabled: true,
        installed: true,
        instanceId: "incident-stage-provider",
        models: [
          {
            isCustom: false,
            name: "Sample Stage Model",
            slug: "sample-stage-model",
          },
        ],
        observedCliVersion: "sample-stage-version",
        state: "ready",
      },
      {
        availability: "available",
        displayName: "Sample Task Workbench",
        driverKind: "codex",
        enabled: true,
        installed: true,
        instanceId: "incident-task-provider",
        models: [
          {
            isCustom: false,
            name: "Sample Task Model",
            slug: "sample-task-model",
          },
        ],
        observedCliVersion: "sample-task-version",
        state: "ready",
      },
    );
    const composition = createProductionComposition({
      workflowMcpEndpoint,
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });
    close = composition.close;
    await composition.start();
    expect(t3.commands.filter(({ type }) => type !== "project.create")).toEqual(
      [],
    );
    await composition.attention.raise(
      productionErrorAttention({
        code: "task-reconciliation-failed",
        error: new Error("Synthetic incident condition"),
        summary: "Sample incident condition",
        taskId: fixture.taskId,
      }),
    );
    await composition.scheduler.trigger();
    return { composition, fixture, t3 };
  };

  const incidentSession = (
    fixture: ProductionFixture,
    composition: Awaited<ReturnType<typeof prepare>>["composition"],
  ) => {
    const incident = composition.persistence.listIncidentRuntime()[0]!;
    expect(incident).toMatchObject({
      provider: expect.any(String),
      stageId: "implement",
      state: "waiting",
      taskId: fixture.taskId,
    });
    const session = composition.persistence
      .listSessionRuntime()
      .find(({ instanceId }) => instanceId === incident.incidentId)!;
    expect(incident.provider).toBe(session.binding.providerInstanceId);
    return session;
  };

  it("uses the pinned incident stage alias and runtime in the durable binding and T3 request", async () => {
    const { composition, fixture, t3 } = await prepare({
      stageAlias: "incident-stage",
    });

    const session = incidentSession(fixture, composition);
    expect(session.binding).toMatchObject({
      alias: "incident-stage",
      driverKind: "cursor",
      modelSlug: "sample-stage-model",
      providerDisplayName: "Sample Stage Workbench",
      providerInstanceId: "incident-stage-provider",
      runtimeMode: "full-access",
    });
    expect(t3.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelSelection: {
            instanceId: "incident-stage-provider",
            model: "sample-stage-model",
          },
          runtimeMode: "full-access",
          threadId: session.threadId,
          type: "thread.create",
        }),
      ]),
    );
    expect(t3.providerContexts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          driver: "cursor",
          providerInstanceId: "incident-stage-provider",
        }),
      ]),
    );
  });

  it("uses a task alias over the pinned incident stage alias", async () => {
    const { composition, fixture, t3 } = await prepare({
      stageAlias: "incident-stage",
      taskAlias: "incident-task",
    });

    const session = incidentSession(fixture, composition);
    expect(session.binding).toMatchObject({
      alias: "incident-task",
      driverKind: "codex",
      modelSlug: "sample-task-model",
      providerInstanceId: "incident-task-provider",
      runtimeMode: "full-access",
    });
    expect(t3.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelSelection: {
            instanceId: "incident-task-provider",
            model: "sample-task-model",
          },
          runtimeMode: "full-access",
          threadId: session.threadId,
          type: "thread.create",
        }),
      ]),
    );
  });

  it.each([
    {
      label: "task override",
      stageAlias: "incident-stage",
      taskAlias: "unknown",
    },
    { label: "stage alias", stageAlias: "unknown", taskAlias: undefined },
  ])("does not fall back from an unknown incident $label", async (input) => {
    const { composition, fixture, t3 } = await prepare(input);

    expect(t3.commands.filter(({ type }) => type !== "project.create")).toEqual(
      [],
    );
    expect(composition.persistence.listSessionRuntime()).toEqual([]);
    expect(composition.persistence.listIncidentRuntime()[0]).toMatchObject({
      state: "failed",
      taskId: fixture.taskId,
    });
    expect(composition.attention.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instanceId: expect.stringMatching(/^incident:/),
          kind: "production-error",
          message: expect.stringContaining("failed"),
        }),
      ]),
    );
  });
});
