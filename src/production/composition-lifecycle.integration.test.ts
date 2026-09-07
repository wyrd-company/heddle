// ---
// relationships:
//   verifies: heddle
// ---

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  bootstrapStageSession,
  builtInSystemPrompt,
} from "../control-plane/index.js";
import { advanceOperationId } from "../mcp-server/operations.js";
import { createProductionComposition } from "./composition.js";
import {
  prepareProductionFixture,
  SyntheticT3,
  execute,
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

  it("starts one durable instance and one project-grouped titled session across restart", async () => {
    const { blueprintsRepositoryRoot, configuration, taskId } = await prepare();
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
      projectId: "workspace-project",
      title: expect.stringContaining(`task-${taskId}`),
      type: "thread.create",
    });
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
    expect(firstT3.timeouts).toHaveLength(1);
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
    expect(secondT3.commands).toHaveLength(0);
    expect(
      second.persistence
        .replayEvents(`task-${taskId}`)
        .filter(({ type }) => type === "session:activated"),
    ).toHaveLength(1);
    await second.close();
  });

  it("raises durable attention and performs no partial dispatch when a handoff include escapes containment", async () => {
    const { blueprintsRepositoryRoot, configuration } = await prepare();
    const invalidTemplate = `---
$schema: https://wyrd.company/heddle/handoff-template.schema.json
relationships:
  implements: heddle
format: heddle.handoff-template
version: 1
kind: standard
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

    expect(t3.commands).toHaveLength(0);
    expect(t3.timeouts).toHaveLength(0);
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

      expect(t3.timeouts).toHaveLength(0);
      expect(t3.mcpRegistrations).toHaveLength(0);
      expect(t3.commands).toHaveLength(0);
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

  it("does not retarget a cold retry through the changed shared default", async () => {
    const { blueprintsRepositoryRoot, configuration } = await prepare();
    class InterruptedT3 extends SyntheticT3 {
      override async dispatch(command: Parameters<SyntheticT3["dispatch"]>[0]) {
        await super.dispatch(command);
        throw new Error("synthetic dispatch interruption");
      }
    }
    const firstT3 = new InterruptedT3();
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
    expect(firstT3.commands).toHaveLength(1);
    const storedBinding = first.persistence.listSessionRuntime()[0]!.binding;
    expect(storedBinding).toMatchObject({
      alias: configuration.session.defaultSelection.alias,
      driverKind: configuration.session.defaultSelection.driverKind,
      modelSlug: configuration.session.defaultSelection.model.slug,
      providerDisplayName:
        configuration.session.defaultSelection.providerDisplayName,
      providerInstanceId:
        configuration.session.defaultSelection.providerInstanceId,
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
    first.attention.resolve(interruptedAttention[0]!.attentionId);
    await first.close();

    const changedConfiguration = {
      ...configuration,
      pacing: { ...configuration.pacing, defaultProvider: "claudeAgent" },
      session: {
        ...configuration.session,
        defaultSelection: {
          ...configuration.session.defaultSelection,
          driverKind: "claudeAgent",
          providerInstanceId: "claudeAgent",
        },
        resolvedSelections: configuration.session.resolvedSelections.map(
          (selection) => ({
            ...selection,
            driverKind: "claudeAgent",
            providerInstanceId: "claudeAgent",
          }),
        ),
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
    expect(secondT3.commands).toHaveLength(2);
    expect(secondT3.providerContexts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          driver: "codex",
          providerInstanceId: "codex",
        }),
      ]),
    );
    expect(
      second.attention
        .list()
        .filter(
          ({ attentionId }) =>
            !attentionId.includes(":incident-execution-failed:"),
        ),
    ).toEqual([]);
    await second.close();
  });

  it("activates the next accepted lifecycle wait stage without losing prior observation", async () => {
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
    const implementBinding =
      composition.persistence.listSessionRuntime()[0]!.binding;
    configuration.session.defaultSelection = {
      alias: "review-selection",
      driverKind: "cursor",
      interactionMode: "plan",
      model: {
        isCustom: false,
        name: "Sample Review Model",
        slug: "sample-review-model",
      },
      observedCliVersion: "sample-review-version",
      providerDisplayName: "Sample Review Workbench",
      providerInstanceId: "review-provider",
      runtimeMode: "full-access",
    };
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
          interactionMode: "plan",
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
    expect(remediationText).not.toContain("private discussion");
    expect(remediationText).not.toContain("transcript");
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

  it("raises durable attention and activates remediation for a legacy findings-less review", async () => {
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
    expect(composition.attention.list()).toEqual([
      expect.objectContaining({
        attentionId: `task-${taskId}:remediate:1:advance-output:findings`,
        instanceId: `task-${taskId}`,
        message: expect.stringContaining(
          'Remediation stage "remediate" received no findings field from stage "review"',
        ),
        taskId,
      }),
    ]);
    expect(composition.persistence.listAttention()).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          code: "advance-output-contract-missing",
        }),
      }),
    ]);
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
        renderedDocument: expect.stringContaining("Review findings: []"),
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

  it("rejects handoff input that disagrees with pinned stage metadata", async () => {
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
    const commandsBeforeMismatch = t3.commands.length;

    await expect(
      bootstrapStageSession(
        {
          handoff: {
            skillPointer: configuration.session.skillPointer,
            stage: {
              kind: "remediation",
              name: "implement",
              review: { findings: [] },
            },
            taskContract: { title: "Example Item" },
          },
          instanceId: `task-${taskId}`,
          interactionMode:
            configuration.session.defaultSelection.interactionMode,
          modelSelection: {
            instanceId:
              configuration.session.defaultSelection.providerInstanceId,
            model: configuration.session.defaultSelection.model.slug,
          },
          projectId: configuration.adHocProject.projectId,
          providerContext: {
            cliVersion:
              configuration.session.defaultSelection.observedCliVersion,
            driver: configuration.session.defaultSelection.driverKind,
            lifecycle: "independent",
            providerInstanceId:
              configuration.session.defaultSelection.providerInstanceId,
          },
          runtimeMode: configuration.session.defaultSelection.runtimeMode,
          sessionKey: `task-${taskId}:mismatch:1`,
          task: { id: taskId, title: "Example Item" },
          taskId,
          title: "Metadata agreement probe",
          worktree: {
            baseRef: configuration.session.baseRef,
            branch: `heddle/task-${taskId}`,
            repositoryName: configuration.products[0]!.repos[0]!.name,
            repositoryRoot: configuration.products[0]!.repos[0]!.repositoryRoot,
            worktreeName: String(taskId),
            worktreesRoot: configuration.session.worktreesRoot,
          },
        },
        {
          persistence: composition.persistence,
          templateAuthority: {
            readHandoffTemplate: async () => {
              throw new Error("Unexpected template read");
            },
            repositoryRoot: blueprintsRepositoryRoot,
          },
          t3,
          workflowMcpEndpoint,
        },
      ),
    ).rejects.toThrow(
      "Stage session bootstrap requires matching wait-stage handoff metadata and tools",
    );
    expect(t3.commands).toHaveLength(commandsBeforeMismatch);
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
          threadId: `review-thread-${activation}`,
        },
        instanceId: `task-${taskId}`,
        projectId: configuration.adHocProject.projectId,
        repositoryName: configuration.products[0]!.repos[0]!.name,
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
