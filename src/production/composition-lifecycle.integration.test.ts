// ---
// relationships:
//   verifies: heddle
// ---

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
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

  it("raises durable attention and performs no partial dispatch when strict rendering fails", async () => {
    const { blueprintsRepositoryRoot, configuration } = await prepare();
    const repositoryRoot = configuration.products[0]!.repos[0]!.repositoryRoot;
    const invalidTemplate = `---
$schema: https://wyrd.company/heddle/handoff-template.schema.json
relationships:
  implements: heddle
format: heddle.handoff-template
version: 1
kind: standard
---
# {{ task.absentTitle }}
`;
    const invalidPath = join(repositoryRoot, "handoff-templates", "invalid.md");
    await writeFile(invalidPath, invalidTemplate);
    const invalidHash = (
      await execute("git", ["hash-object", "-w", invalidPath], {
        cwd: repositoryRoot,
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
      blobHash: invalidHash,
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
      blueprintsRepositoryRoot,
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    });
    await expect(composition.start()).rejects.toThrow(
      /Handoff template render failed/,
    );
    await expect(composition.scheduler.trigger()).rejects.toThrow(
      /Handoff template render failed/,
    );

    expect(t3.commands).toHaveLength(0);
    expect(t3.timeouts).toHaveLength(0);
    expect(composition.attention.list()).toEqual([
      expect.objectContaining({
        kind: "lifecycle-resolution",
        message: expect.stringContaining("Handoff template render failed"),
      }),
    ]);
    await composition.close();
  });

  it("raises durable attention without partial dispatch when a cold retry changes handoff authentication policy", async () => {
    const { blueprintsRepositoryRoot, configuration } = await prepare();
    class InterruptedT3 extends SyntheticT3 {
      override async dispatch(command: Parameters<SyntheticT3["dispatch"]>[0]) {
        await super.dispatch(command);
        throw new Error("synthetic dispatch interruption");
      }
    }
    const firstT3 = new InterruptedT3();
    const first = createProductionComposition({
      blueprintsRepositoryRoot,
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: firstT3,
    });
    await expect(first.start()).rejects.toThrow(
      /synthetic dispatch interruption/,
    );
    expect(firstT3.commands).toHaveLength(1);
    await first.close();

    const changedConfiguration = {
      ...configuration,
      pacing: { ...configuration.pacing, defaultProvider: "claudeAgent" },
      session: { ...configuration.session, driver: "claudeAgent" },
    };
    const secondT3 = new SyntheticT3();
    const second = createProductionComposition({
      blueprintsRepositoryRoot,
      configuration: changedConfiguration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: secondT3,
    });

    await expect(second.start()).rejects.toThrow(
      /authentication binding is incompatible/,
    );
    expect(secondT3.commands).toHaveLength(0);
    expect(secondT3.timeouts).toHaveLength(0);
    expect(second.attention.list()).toEqual([
      expect.objectContaining({
        attentionId: expect.stringContaining(":handoff-render"),
        kind: "lifecycle-resolution",
        message: expect.stringContaining(
          "authentication binding is incompatible",
        ),
      }),
    ]);
    await second.close();
  });

  it("activates the next accepted lifecycle wait stage without losing prior observation", async () => {
    const { blueprintsRepositoryRoot, configuration, taskId } = await prepare();
    const t3 = new SyntheticT3();
    const composition = createProductionComposition({
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
      output: { result: { count: 2 } },
    });
    await composition.scheduler.trigger();

    expect(composition.persistence.listReconcilerRuntime()).toMatchObject([
      { stageId: "review", state: "waiting", taskId },
    ]);
    expect(composition.persistence.listSessionRuntime()).toMatchObject([
      { stageId: "implement" },
      { stageId: "review" },
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

  it("uses a new deterministic activation identity when a stage recurs", async () => {
    const { blueprintsRepositoryRoot, configuration, taskId } = await prepare();
    const t3 = new SyntheticT3();
    const composition = createProductionComposition({
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

  it("fails closed when remediation has no canonical review findings", async () => {
    const { blueprintsRepositoryRoot, configuration, taskId } = await prepare();
    const composition = createProductionComposition({
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

    await expect(composition.scheduler.trigger()).rejects.toThrow(
      'Remediation stage "remediate" has no canonical review findings',
    );
    await composition.close();
  });

  it("rejects handoff input that disagrees with pinned stage metadata", async () => {
    const { blueprintsRepositoryRoot, configuration, taskId } = await prepare();
    const t3 = new SyntheticT3();
    const composition = createProductionComposition({
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
          interactionMode: configuration.session.interactionMode,
          modelSelection: {
            instanceId: configuration.session.driver,
            model: configuration.session.model,
          },
          projectId: configuration.adHocProject.projectId,
          providerContext: {
            cliVersion: configuration.session.cliVersion,
            driver: configuration.session.driver,
            lifecycle: "independent",
          },
          runtimeMode: configuration.session.runtimeMode,
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
          blueprintsRepositoryRoot,
          persistence: composition.persistence,
          t3,
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

  it("keeps a double-digit occurrence identity after session intent persistence", async () => {
    const { blueprintsRepositoryRoot, configuration, taskId } = await prepare();
    const first = createProductionComposition({
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
