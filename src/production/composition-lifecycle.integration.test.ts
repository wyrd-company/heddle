// ---
// relationships:
//   verifies: heddle
// ---

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { builtInSystemPrompt } from "../control-plane/index.js";
import { readLifecycleContext } from "../engine/index.js";
import { advanceOperationId } from "../mcp-server/operations.js";
import { createProductionComposition } from "./composition.js";
import {
  SyntheticT3,
  declareTaskFileProperty,
  execute,
  prepareProductionFixture,
  setBoardTaskRepositories,
} from "./composition.test-support.js";

const workflowMcpEndpoint = "http://127.0.0.1:4774/mcp";

describe("production lifecycle composition", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
  });

  const prepare = async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    return fixture;
  };

  it("starts one durable project-grouped session, prepares every scoped repository, and retains it across restart", async () => {
    const { blueprintsRepositoryRoot, configuration, root, taskId } =
      await prepare();
    const secondRepositoryRoot = join(root, "tools", "sample-secondary");
    await mkdir(secondRepositoryRoot);
    await writeFile(join(secondRepositoryRoot, "inventory.txt"), "one\n");
    await execute("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: secondRepositoryRoot,
    });
    await execute("git", ["add", "inventory.txt"], {
      cwd: secondRepositoryRoot,
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
        "Add sample inventory",
      ],
      { cwd: secondRepositoryRoot },
    );
    await setBoardTaskRepositories(
      configuration.boardDirectory,
      Number(String(taskId)),
      "sample-secondary,sample-repository".split(","),
    );
    const blueprintPath = join(
      blueprintsRepositoryRoot,
      "blueprints",
      "sample.json",
    );
    const blueprint = JSON.parse(await readFile(blueprintPath, "utf8")) as {
      nodes: Array<Record<string, unknown>>;
    };
    blueprint.nodes.find(({ id }) => id === "implement")!["repo"] =
      "sample-repository";
    await writeFile(blueprintPath, `${JSON.stringify(blueprint, null, 2)}\n`);
    await execute("git", ["add", "blueprints/sample.json"], {
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
        "Select sample session repository",
      ],
      { cwd: blueprintsRepositoryRoot },
    );
    await execute("git", ["push", "--quiet"], {
      cwd: blueprintsRepositoryRoot,
    });
    const firstT3 = new SyntheticT3();
    const transport = { send: vi.fn(async () => undefined) };
    const first = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot,
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: transport,
      t3: firstT3,
    });
    await first.start();
    await first.scheduler.trigger();
    const sharedProjectId = first.persistence.getSharedProject()!.projectId;

    expect(first.persistence.listInstances()).toHaveLength(1);
    expect(first.persistence.listReconcilerRuntime()).toMatchObject([
      { state: "waiting", taskId },
    ]);
    const create = firstT3.commands.find(
      ({ type }) => type === "thread.create",
    );
    const turn = firstT3.commands.find(
      ({ type }) => type === "thread.turn.start",
    );
    expect(create).toMatchObject({
      projectId: sharedProjectId,
      title: expect.stringContaining(`task-${taskId}`),
      type: "thread.create",
      worktreePath: join(
        configuration.session.worktreesRoot!,
        String(taskId),
        "sample-repository",
      ),
    });
    expect(first.persistence.listSessionRuntime()).toMatchObject([
      { repositoryName: "sample-repository" },
    ]);
    await expect(
      stat(
        join(
          configuration.session.worktreesRoot!,
          String(taskId),
          "sample-repository",
          ".git",
        ),
      ),
    ).resolves.toBeDefined();
    await expect(
      stat(
        join(
          configuration.session.worktreesRoot!,
          String(taskId),
          "sample-secondary",
          ".git",
        ),
      ),
    ).resolves.toBeDefined();
    expect(turn).not.toHaveProperty("titleSeed");
    const renderedDocument = (turn?.["message"] as { text: string }).text;
    expect(renderedDocument.startsWith(`${builtInSystemPrompt}\n\n`)).toBe(
      true,
    );
    expect(renderedDocument).toContain('format: "heddle.stage-handoff"');
    expect(
      first.persistence
        .replayEvents(`task-${taskId}`)
        .filter(({ type }) => type === "session:activated"),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          renderedDocument,
          systemPrompt: builtInSystemPrompt,
          sessionKey: `task-${taskId}:implement:1`,
          taskId,
        }),
      }),
    ]);
    await first.close();

    const secondT3 = new SyntheticT3();
    const second = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot,
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: transport,
      t3: secondT3,
    });
    await second.start();
    expect(second.persistence.listInstances()).toHaveLength(1);
    expect(
      secondT3.commands.filter(({ type }) => type !== "project.create"),
    ).toHaveLength(0);
    expect(
      second.persistence
        .replayEvents(`task-${taskId}`)
        .filter(({ type }) => type === "session:activated"),
    ).toHaveLength(1);
    await second.close();
  });

  it("fails restart closed when a legacy active context has no retained repository scope", async () => {
    const { blueprintsRepositoryRoot, configuration, taskId } = await prepare();
    const first = createProductionComposition({
      workflowMcpEndpoint,
      blueprintsRepositoryRoot,
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    });
    await first.start();
    const instanceId = `task-${taskId}`;
    await first.lifecycle.resume({
      disposition: "complete",
      instanceId,
      operationId: advanceOperationId(`${instanceId}:implement:1`),
    });
    const record = first.persistence.getInstance(instanceId)!;
    const context = readLifecycleContext(record);
    const serialized = JSON.parse(context.serializedContext!) as {
      taskContract: Record<string, unknown>;
    };
    delete serialized.taskContract["repos"];
    first.persistence.updateInstance(instanceId, {
      ...record.state,
      flowcraftContext: {
        ...context,
        serializedContext: JSON.stringify(serialized),
      },
    });
    await first.close();

    const restartedT3 = new SyntheticT3();
    const restarted = createProductionComposition({
      workflowMcpEndpoint,
      blueprintsRepositoryRoot,
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: restartedT3,
    });
    await restarted.start();

    expect(restarted.attention.list()).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          `Task ${taskId} has no retained repository scope; operator recovery is required`,
        ),
        taskId,
      }),
    );
    expect(
      restartedT3.commands.filter(({ type }) => type === "thread.create"),
    ).toHaveLength(0);
    await restarted.close();
  });

  it("raises durable attention and performs no partial dispatch when a handoff include escapes containment", async () => {
    const { blueprintsRepositoryRoot, configuration } = await prepare();
    const invalidTemplate = `---
$schema: https://wyrd.company/heddle/handoff-template.schema.json
relationships:
  implements: heddle
format: heddle.handoff-template
kind: invalid
version: 1
---
{% include "handoff-templates/includes/../outside.md" %}
`;
    const invalidPath = join(
      blueprintsRepositoryRoot,
      "handoff-templates",
      "invalid.md",
    );
    await writeFile(invalidPath, invalidTemplate);
    await execute("git", ["add", "--", "handoff-templates/invalid.md"], {
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
        "Add invalid sample template",
      ],
      { cwd: blueprintsRepositoryRoot },
    );
    const invalidCommitSha = (
      await execute("git", ["rev-parse", "HEAD"], {
        cwd: blueprintsRepositoryRoot,
      })
    ).stdout.trim();
    const blueprintPath = join(
      blueprintsRepositoryRoot,
      "blueprints",
      "sample.json",
    );
    const blueprint = JSON.parse(await readFile(blueprintPath, "utf8")) as {
      nodes: Array<Record<string, unknown>>;
    };
    blueprint.nodes[0]!["handoff-template"] = {
      commitSha: invalidCommitSha,
      kind: "invalid",
      path: "handoff-templates/invalid.md",
    };
    await writeFile(blueprintPath, JSON.stringify(blueprint));
    await execute("git", ["add", "--", "blueprints/sample.json"], {
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
        "Use invalid sample template",
      ],
      { cwd: blueprintsRepositoryRoot },
    );
    await execute("git", ["push", "--quiet"], {
      cwd: blueprintsRepositoryRoot,
    });
    const t3 = new SyntheticT3();
    const composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot,
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });
    await expect(composition.start()).resolves.toBeUndefined();
    await expect(composition.scheduler.trigger()).resolves.toBeUndefined();

    expect(
      t3.commands.filter(({ type }) => type !== "project.create"),
    ).toHaveLength(0);
    expect(composition.attention.list()).toEqual([
      expect.objectContaining({
        kind: "lifecycle-resolution",
        message: expect.stringContaining(
          "repository-relative path inside handoff-templates/includes/",
        ),
      }),
    ]);
    await composition.close();
  });

  it.each([
    {
      diagnostic: "is unavailable at commit",
      label: "missing skill folder",
      source: undefined,
      supportingFile: false,
    },
    {
      diagnostic: "is unavailable at commit",
      label: "missing SKILL.md",
      source: undefined,
      supportingFile: true,
    },
    {
      diagnostic: "front matter name must equal its folder name",
      label: "front-matter name mismatch",
      source:
        "---\nname: other-skill\ndescription: Inspect evidence.\n---\n\nInspect it.\n",
      supportingFile: false,
    },
    {
      diagnostic: "front matter description must contain 1 to 1,024 characters",
      label: "missing front-matter description",
      source: "---\nname: evidence-review\n---\n\nInspect it.\n",
      supportingFile: false,
    },
    {
      diagnostic: "front matter description must contain 1 to 1,024 characters",
      label: "overlong front-matter description",
      source: `---\nname: evidence-review\ndescription: ${"a".repeat(1_025)}\n---\n\nInspect it.\n`,
      supportingFile: false,
    },
    {
      diagnostic: "front matter is invalid",
      label: "invalid front-matter YAML",
      source:
        "---\nname: [\ndescription: Inspect evidence.\n---\n\nInspect it.\n",
      supportingFile: false,
    },
    {
      diagnostic: "front matter name must equal its folder name",
      label: "missing required front-matter name",
      source: "---\ndescription: Inspect evidence.\n---\n\nInspect it.\n",
      supportingFile: false,
    },
  ])(
    "raises stable lifecycle-resolution attention before dispatch for $label",
    async ({ diagnostic, source, supportingFile }) => {
      const { blueprintsRepositoryRoot, configuration } = await prepare();
      const skillDirectory = join(
        blueprintsRepositoryRoot,
        "skills",
        "evidence-review",
      );
      await mkdir(skillDirectory, { recursive: true });
      if (source !== undefined) {
        await writeFile(join(skillDirectory, "SKILL.md"), source);
      } else if (supportingFile) {
        await writeFile(
          join(skillDirectory, "README.md"),
          "# Evidence review fixture\n",
        );
      }
      if (source !== undefined || supportingFile) {
        await execute("git", ["add", "--", "skills/evidence-review"], {
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
            "Add invalid fixture skill",
          ],
          { cwd: blueprintsRepositoryRoot },
        );
      }
      const skillCommitSha = (
        await execute("git", ["rev-parse", "HEAD"], {
          cwd: blueprintsRepositoryRoot,
        })
      ).stdout.trim();
      const blueprintPath = join(
        blueprintsRepositoryRoot,
        "blueprints",
        "sample.json",
      );
      const blueprint = JSON.parse(await readFile(blueprintPath, "utf8")) as {
        nodes: Array<Record<string, unknown>>;
      };
      blueprint.nodes[0]!["skills"] = ["evidence-review"];
      blueprint.nodes[0]!["handoff-template"] = {
        commitSha: skillCommitSha,
        kind: "standard",
        path: "handoff-templates/standard.md",
      };
      await writeFile(blueprintPath, JSON.stringify(blueprint));
      await execute("git", ["add", "--", "blueprints/sample.json"], {
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
          "Bind invalid fixture skill",
        ],
        { cwd: blueprintsRepositoryRoot },
      );
      await execute("git", ["push", "--quiet"], {
        cwd: blueprintsRepositoryRoot,
      });
      const t3 = new SyntheticT3();
      const composition = createProductionComposition({
        workflowMcpEndpoint,
        blueprintsRepositoryRoot,
        configuration,
        providerUsage: {
          readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
        },
        pushoverTransport: { send: vi.fn(async () => undefined) },
        t3,
      });

      await expect(composition.start()).resolves.toBeUndefined();
      await expect(composition.scheduler.trigger()).resolves.toBeUndefined();
      expect(t3.mcpRegistrations).toHaveLength(0);
      expect(
        t3.commands.filter(({ type }) => type !== "project.create"),
      ).toHaveLength(0);
      expect(composition.attention.list()).toEqual([
        expect.objectContaining({
          attentionId: expect.stringContaining(":handoff-render"),
          kind: "lifecycle-resolution",
          message: expect.stringContaining(diagnostic),
        }),
      ]);
      await composition.close();
    },
  );

  it("does not retarget an exhausted occurrence through a task edit or changed shared default", async () => {
    const { blueprintsRepositoryRoot, configuration } = await prepare();
    configuration.providerAliases["specialist"] = {
      model: "sample-specialist-model",
      providerDisplayName: "Sample Specialist Workbench",
    };
    configuration.session.resolvedSelections.push({
      ...configuration.session.defaultSelection,
      alias: "specialist",
      model: {
        ...configuration.session.defaultSelection.model,
        name: "Sample Specialist Model",
        slug: "sample-specialist-model",
      },
      providerDisplayName: "Sample Specialist Workbench",
      providerInstanceId: "specialist-provider",
    });
    const [taskFilename] = await readdir(
      join(configuration.boardDirectory, "tasks"),
    );
    const taskPath = join(configuration.boardDirectory, "tasks", taskFilename!);
    await declareTaskFileProperty(
      taskPath,
      "provider-alias:\n    implement: specialist",
    );
    class InterruptedT3 extends SyntheticT3 {
      override async dispatch(command: Parameters<SyntheticT3["dispatch"]>[0]) {
        const result = await super.dispatch(command);
        if (command.type !== "project.create") {
          throw new Error("synthetic dispatch interruption");
        }
        return result;
      }
    }
    const firstT3 = new InterruptedT3();
    firstT3.providerCatalog.push({
      availability: "available",
      displayName: "Sample Specialist Workbench",
      driverKind: "codex",
      enabled: true,
      installed: true,
      instanceId: "specialist-provider",
      models: [
        {
          isCustom: false,
          name: "Sample Specialist Model",
          slug: "sample-specialist-model",
        },
      ],
      observedCliVersion: "0.91.0",
      state: "ready",
    });
    const first = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot,
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: firstT3,
    });
    await expect(first.start()).resolves.toBeUndefined();
    expect(
      firstT3.commands.filter(({ type }) => type !== "project.create"),
    ).toHaveLength(1);
    const storedBinding = first.persistence.listSessionRuntime()[0]!.binding;
    expect(storedBinding).toMatchObject({
      alias: "specialist",
      driverKind: configuration.session.defaultSelection.driverKind,
      modelSlug: "sample-specialist-model",
      providerDisplayName: "Sample Specialist Workbench",
      providerInstanceId: "specialist-provider",
    });
    const interruptedAttention = first.attention
      .list()
      .filter(
        ({ attentionId }) =>
          !attentionId.includes(":incident-execution-failed:"),
      );
    expect(interruptedAttention).toEqual([
      expect.objectContaining({
        kind: "production-error",
        message: expect.stringContaining("synthetic dispatch interruption"),
      }),
    ]);
    await first.close();
    await writeFile(
      taskPath,
      (await readFile(taskPath, "utf8")).replace(
        "implement: specialist",
        "absent-stage: specialist",
      ),
    );

    const changedConfiguration = {
      ...configuration,
      providerAliases: {
        ...configuration.providerAliases,
        changed: {
          model: configuration.session.defaultSelection.model.slug,
          providerDisplayName:
            configuration.session.defaultSelection.providerDisplayName,
        },
      },
      session: {
        ...configuration.session,
        defaultSelection: {
          ...configuration.session.defaultSelection,
          alias: "changed",
        },
        defaultProviderAlias: "changed",
        resolvedSelections: [
          ...configuration.session.resolvedSelections,
          {
            ...configuration.session.defaultSelection,
            alias: "changed",
          },
        ],
      },
    };
    const secondT3 = new SyntheticT3();
    const second = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot,
      configuration: changedConfiguration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: secondT3,
    });

    await expect(second.start()).resolves.toBeUndefined();
    expect(second.persistence.listSessionRuntime()[0]!.binding).toEqual(
      storedBinding,
    );
    expect(
      secondT3.commands.filter(({ type }) => type !== "project.create"),
    ).toHaveLength(0);
    expect(secondT3.providerContexts).toEqual([]);
    expect(second.persistence.listReconcilerRuntime()).toMatchObject([
      { provider: "specialist-provider", state: "waiting" },
    ]);
    expect(
      second.attention
        .list()
        .filter(
          ({ attentionId }) =>
            !attentionId.includes(":incident-execution-failed:"),
        ),
    ).toEqual([
      expect.objectContaining({
        kind: "production-error",
        message: expect.stringContaining("synthetic dispatch interruption"),
      }),
    ]);
    await second.close();
  });

  it("activates the next accepted lifecycle wait stage without losing prior observation", async () => {
    const { blueprintsRepositoryRoot, configuration, taskId } = await prepare();
    configuration.providerAliases["review-selection"] = {
      model: "sample-review-model",
      providerDisplayName: "Sample Review Workbench",
    };
    const reviewSelection = {
      alias: "review-selection",
      driverKind: "cursor" as const,
      interactionMode: "plan" as const,
      model: {
        isCustom: false,
        name: "Sample Review Model",
        slug: "sample-review-model",
      },
      observedCliVersion: "sample-review-version",
      providerDisplayName: "Sample Review Workbench",
      providerInstanceId: "review-provider",
      runtimeMode: "full-access" as const,
    };
    configuration.session.resolvedSelections.push(reviewSelection);
    const blueprintPath = join(
      blueprintsRepositoryRoot,
      "blueprints/sample.json",
    );
    const blueprint = JSON.parse(await readFile(blueprintPath, "utf8")) as {
      nodes: Array<Record<string, unknown>>;
    };
    blueprint.nodes.find(({ id }) => id === "review")!["provider-alias"] =
      "review-selection";
    blueprint.nodes.find(({ id }) => id === "review")!["runtime-mode"] =
      "full-access";
    await writeFile(blueprintPath, `${JSON.stringify(blueprint, null, 2)}\n`);
    await execute("git", ["add", "blueprints/sample.json"], {
      cwd: blueprintsRepositoryRoot,
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
        "Select sample review provider",
      ],
      { cwd: blueprintsRepositoryRoot },
    );
    await execute("git", ["push", "--quiet"], {
      cwd: blueprintsRepositoryRoot,
    });
    const t3 = new SyntheticT3();
    t3.providerCatalog.push({
      availability: "available",
      displayName: "Sample Review Workbench",
      driverKind: "cursor",
      enabled: true,
      installed: true,
      instanceId: "review-provider",
      models: [
        {
          isCustom: false,
          name: "Sample Review Model",
          slug: "sample-review-model",
        },
      ],
      observedCliVersion: "sample-review-version",
      state: "ready",
    });
    const composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot,
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });
    await composition.start();
    const implementBinding =
      composition.persistence.listSessionRuntime()[0]!.binding;
    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId: `task-${taskId}`,
      operationId: advanceOperationId(`task-${taskId}:implement:1`),
      output: { result: { count: 2 } },
    });
    await composition.scheduler.trigger();

    expect(composition.persistence.listReconcilerRuntime()).toMatchObject([
      { stageId: "review", state: "waiting", taskId },
    ]);
    expect(composition.persistence.listSessionRuntime()).toMatchObject([
      { binding: implementBinding, stageId: "implement" },
      {
        binding: {
          alias: "review-selection",
          driverKind: "cursor",
          interactionMode: "default",
          modelSlug: "sample-review-model",
          observedCliVersion: "sample-review-version",
          providerDisplayName: "Sample Review Workbench",
          providerInstanceId: "review-provider",
          runtimeMode: "full-access",
        },
        stageId: "review",
      },
    ]);
    const creates = t3.commands.filter(({ type }) => type === "thread.create");
    expect(creates).toHaveLength(2);
    expect(creates[0]?.title).not.toBe(creates[1]?.title);
    expect(creates[0]?.branch).toBe(`heddle/task-${taskId}`);
    expect(creates[1]?.branch).toBe(creates[0]?.branch);
    expect(creates[1]?.worktreePath).toBe(creates[0]?.worktreePath);
    const reviewTurn = t3.commands.filter(
      ({ type }) => type === "thread.turn.start",
    )[1];
    const reviewHandoff = (reviewTurn?.["message"] as { text: string }).text;
    expect(reviewHandoff).toContain("Stage: review");
    expect(reviewHandoff).toContain('"count": 2');
    expect(
      await composition.consoleState.listEvents({ afterSequence: 0 }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "observation:thread-recorded" }),
      ]),
    );
    await composition.close();
  });

  it("removes recovered-session liveness attention while preserving unrelated attention across restart", async () => {
    const { blueprintsRepositoryRoot, configuration, taskId } = await prepare();
    configuration.observationThresholds = {
      endedMilliseconds: 1,
      failedMilliseconds: 1,
      stalledMilliseconds: 1,
    };
    const t3 = new SyntheticT3();
    const create = () =>
      createProductionComposition({
        workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
        blueprintsRepositoryRoot,
        configuration,
        providerUsage: {
          readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
        },
        pushoverTransport: { send: vi.fn(async () => undefined) },
        t3,
      });
    const first = create();
    await first.start();
    const instanceId = `task-${taskId}`;
    const implement = first.persistence
      .listSessionRuntime()
      .find(({ stageId }) => stageId === "implement")!;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
    await first.scheduler.trigger();
    const stale = first.attention
      .list()
      .find(({ kind }) => kind === "stalled")!;
    expect(stale).toMatchObject({
      instanceId,
      taskId,
    });
    const approvalId = "sample-unrelated-approval";
    await first.attention.raise({
      attentionId: approvalId,
      instanceId,
      kind: "approval",
      message: "Session has pending approval",
      requestId: "request-one",
      sessionKey: implement.sessionKey,
      threadId: implement.threadId,
    });

    await first.lifecycle.resume({
      disposition: "complete",
      instanceId,
      operationId: advanceOperationId(implement.sessionKey),
    });
    await first.scheduler.trigger();

    expect(first.persistence.listReconcilerRuntime()).toContainEqual(
      expect.objectContaining({ stageId: "review", state: "waiting", taskId }),
    );
    expect(first.attention.list()).toContainEqual(
      expect.objectContaining({ attentionId: approvalId, kind: "approval" }),
    );
    expect(first.attention.list()).not.toContainEqual(
      expect.objectContaining({ attentionId: stale.attentionId }),
    );
    expect(await first.attention.has(stale.attentionId)).toBe(true);
    expect(
      first.persistence
        .replayEvents(instanceId)
        .filter(({ type }) => type === "observation:attention-required"),
    ).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ attentionId: stale.attentionId }),
      }),
    );
    await first.close();

    const restarted = create();
    await restarted.start();

    expect(restarted.attention.list()).toContainEqual(
      expect.objectContaining({ attentionId: approvalId, kind: "approval" }),
    );
    expect(restarted.attention.list()).not.toContainEqual(
      expect.objectContaining({ attentionId: stale.attentionId }),
    );
    expect(await restarted.attention.has(stale.attentionId)).toBe(true);
    await restarted.close();
  });

  it("uses a new deterministic activation identity when a stage recurs", async () => {
    const { blueprintsRepositoryRoot, configuration, taskId } = await prepare();
    const t3 = new SyntheticT3();
    const composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot,
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });
    await composition.start();
    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId: `task-${taskId}`,
      operationId: advanceOperationId(`task-${taskId}:implement:1`),
    });
    await composition.scheduler.trigger();
    await composition.lifecycle.resume({
      disposition: "reject",
      instanceId: `task-${taskId}`,
      operationId: advanceOperationId(`task-${taskId}:review:1`),
      output: {
        findings: [{ code: "P1", summary: "The recorded count is unchecked" }],
        transcript: ["private discussion"],
      },
    });
    await composition.scheduler.trigger();
    const remediationTurn = t3.commands.filter(
      ({ type }) => type === "thread.turn.start",
    )[2];
    const remediationText = (remediationTurn?.["message"] as { text: string })
      .text;
    expect(remediationText).toContain("Stage: remediate");
    expect(remediationText).toContain("The recorded count is unchecked");
    // The entry is the reviewer's complete advance output; what the template
    // shows of it is the author's choice, not Heddle's.
    expect(remediationText).toContain("private discussion");
    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId: `task-${taskId}`,
      operationId: advanceOperationId(`task-${taskId}:remediate:1`),
      output: { correction: { count: 3 } },
    });
    await composition.scheduler.trigger();

    const reviewSessions = composition.persistence
      .listSessionRuntime()
      .filter(({ stageId }) => stageId === "review");
    expect(reviewSessions).toHaveLength(2);
    expect(reviewSessions[0]?.sessionKey).not.toBe(
      reviewSessions[1]?.sessionKey,
    );
    expect(reviewSessions[0]?.threadId).not.toBe(reviewSessions[1]?.threadId);
    const reviewTitles = t3.commands
      .filter(
        ({ threadId, type }) =>
          type === "thread.create" &&
          reviewSessions.some((session) => session.threadId === threadId),
      )
      .map(({ title }) => title);
    expect(new Set(reviewTitles).size).toBe(2);
    const repeatedReviewTurn = t3.commands.filter(
      ({ type }) => type === "thread.turn.start",
    )[3];
    const repeatedReviewHandoff = (
      repeatedReviewTurn?.["message"] as { text: string }
    ).text;
    expect(repeatedReviewHandoff).toContain('"correction": {');
    expect(repeatedReviewHandoff).toContain('"count": 3');
    await composition.close();
  });

  it("activates remediation with the review output as the stage entry", async () => {
    const { blueprintsRepositoryRoot, configuration, taskId } = await prepare();
    const composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot,
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    });
    await composition.start();
    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId: `task-${taskId}`,
      operationId: advanceOperationId(`task-${taskId}:implement:1`),
    });
    await composition.scheduler.trigger();
    await composition.lifecycle.resume({
      disposition: "reject",
      instanceId: `task-${taskId}`,
      operationId: advanceOperationId(`task-${taskId}:review:1`),
    });

    await expect(composition.scheduler.trigger()).resolves.toBeUndefined();
    expect(composition.attention.list()).toEqual([]);
    expect(
      composition.persistence
        .listReconcilerRuntime()
        .find((runtime) => runtime.instanceId === `task-${taskId}`),
    ).toMatchObject({ stageId: "remediate", state: "waiting" });
    const remediationTurn = composition.persistence
      .replayEvents(`task-${taskId}`)
      .filter(({ type }) => type === "session:activated")
      .at(-1);
    expect(remediationTurn).toMatchObject({
      payload: expect.objectContaining({
        renderedDocument: expect.stringContaining(
          'Entry: review {\n  "disposition": "reject",',
        ),
        stage: "remediate",
      }),
    });
    await composition.close();
  });

  it("raises durable attention when a remediation session activation fails", async () => {
    const { blueprintsRepositoryRoot, configuration, taskId } = await prepare();
    configuration.cadenceMilliseconds = 750;
    class RemediationFailureT3 extends SyntheticT3 {
      override async dispatch(command: Parameters<SyntheticT3["dispatch"]>[0]) {
        if (
          command.type === "thread.create" &&
          command.title === `task-${taskId} · remediate-1`
        ) {
          throw new Error("Injected remediation activation failure");
        }
        return super.dispatch(command);
      }
    }
    const composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot,
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new RemediationFailureT3(),
    });
    await composition.start();
    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId: `task-${taskId}`,
      operationId: advanceOperationId(`task-${taskId}:implement:1`),
    });
    await vi.waitFor(
      () => {
        expect(
          composition.persistence
            .listReconcilerRuntime()
            .find(({ taskId: value }) => value === taskId),
        ).toMatchObject({ stageId: "review", state: "waiting" });
      },
      { timeout: 3_000 },
    );
    await composition.lifecycle.resume({
      disposition: "reject",
      instanceId: `task-${taskId}`,
      operationId: advanceOperationId(`task-${taskId}:review:1`),
      output: {
        findings: [{ code: "P1", summary: "The sample value is unchecked" }],
      },
    });

    await vi.waitFor(
      () => {
        expect(composition.attention.list()).toContainEqual(
          expect.objectContaining({
            kind: "production-error",
            message: expect.stringContaining(
              "Injected remediation activation failure",
            ),
            taskId,
          }),
        );
      },
      { timeout: 3_000 },
    );
    await composition.close();
  });

  it("keeps the intended occurrence after a crash before session intent persistence", async () => {
    const { blueprintsRepositoryRoot, configuration, taskId } = await prepare();
    const first = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot,
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    });
    await first.start();
    await first.lifecycle.resume({
      disposition: "complete",
      instanceId: `task-${taskId}`,
      operationId: advanceOperationId(`task-${taskId}:implement:1`),
    });
    const runtime = first.persistence.listReconcilerRuntime()[0]!;
    first.persistence.writeReconcilerRuntime({
      ...runtime,
      sessionKey: `task-${taskId}:review:1`,
      stageId: "review",
      state: "starting",
      threadId: "review-thread-1",
    });
    await first.close();

    const t3 = new SyntheticT3();
    const restarted = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot,
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });
    await restarted.start();

    expect(restarted.persistence.listSessionRuntime()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionKey: `task-${taskId}:review:1`,
          threadId: "review-thread-1",
        }),
      ]),
    );
    expect(
      t3.commands.find(({ type }) => type === "thread.create")?.title,
    ).toContain("review-1");
    await restarted.close();
  });

  it("keeps a starting occurrence identity when restart pacing defers dispatch", async () => {
    const { blueprintsRepositoryRoot, configuration, taskId } = await prepare();
    const first = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot,
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    });
    await first.start();
    await first.lifecycle.resume({
      disposition: "complete",
      instanceId: `task-${taskId}`,
      operationId: advanceOperationId(`task-${taskId}:implement:1`),
    });
    const intendedSessionKey = `task-${taskId}:review:1`;
    const intendedThreadId = "review-thread-1";
    first.persistence.writeReconcilerRuntime({
      ...first.persistence.listReconcilerRuntime()[0]!,
      boardStatus: "todo",
      sessionKey: intendedSessionKey,
      stageId: "review",
      state: "starting",
      threadId: intendedThreadId,
    });
    await first.close();

    configuration.pacing.maxConcurrentSessions = 0;
    const t3 = new SyntheticT3();
    const restarted = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot,
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });
    await restarted.start();

    expect(
      restarted.persistence
        .listSessionRuntime()
        .filter(({ stageId }) => stageId === "review"),
    ).toEqual([
      expect.objectContaining({
        activation: 1,
        sessionKey: intendedSessionKey,
        threadId: intendedThreadId,
      }),
    ]);
    expect(t3.commands.filter(({ type }) => type === "thread.create")).toEqual([
      expect.objectContaining({ threadId: intendedThreadId }),
    ]);
    expect(
      restarted.persistence
        .replayEvents(`task-${taskId}`)
        .filter(
          ({ payload, type }) =>
            type === "session:activated" &&
            typeof payload === "object" &&
            payload !== null &&
            !Array.isArray(payload) &&
            payload["stage"] === "review",
        ),
    ).toHaveLength(1);
    await restarted.close();
  });

  it("keeps a double-digit occurrence identity after session intent persistence", async () => {
    const { blueprintsRepositoryRoot, configuration, taskId } = await prepare();
    const first = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot,
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    });
    await first.start();
    const sharedProjectId = first.persistence.getSharedProject()!.projectId;
    await first.lifecycle.resume({
      disposition: "complete",
      instanceId: `task-${taskId}`,
      operationId: advanceOperationId(`task-${taskId}:implement:1`),
    });
    for (let activation = 1; activation <= 10; activation += 1) {
      first.persistence.writeSessionRuntime({
        activation,
        binding: {
          alias: configuration.session.defaultSelection.alias,
          candidatePosition: 1,
          driverKind: configuration.session.defaultSelection.driverKind,
          interactionMode:
            configuration.session.defaultSelection.interactionMode,
          modelSlug: configuration.session.defaultSelection.model.slug,
          observedCliVersion:
            configuration.session.defaultSelection.observedCliVersion,
          providerDisplayName:
            configuration.session.defaultSelection.providerDisplayName,
          providerInstanceId:
            configuration.session.defaultSelection.providerInstanceId,
          runtimeMode: configuration.session.defaultSelection.runtimeMode,
          sessionKey: `task-${taskId}:review:${activation}`,
          skippedCandidates: [],
          threadId: `review-thread-${activation}`,
        },
        instanceId: `task-${taskId}`,
        kind: "stage",
        projectId: sharedProjectId,
        repositoryName: "sample-repository",
        sessionKey: `task-${taskId}:review:${activation}`,
        stageId: "review",
        threadId: `review-thread-${activation}`,
      });
    }
    const runtime = first.persistence.listReconcilerRuntime()[0]!;
    first.persistence.writeReconcilerRuntime({
      ...runtime,
      sessionKey: `task-${taskId}:review:10`,
      stageId: "review",
      state: "starting",
      threadId: "review-thread-10",
    });
    await first.close();

    const t3 = new SyntheticT3();
    const restarted = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot,
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });
    await restarted.start();

    expect(
      t3.commands.find(({ type }) => type === "thread.create")?.title,
    ).toContain("review-10");
    await restarted.close();
  });
});
