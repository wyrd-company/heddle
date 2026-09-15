// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  lifecycleProjectionOf,
  readLifecycleContext,
} from "../engine/index.js";
import { advanceOperationId } from "../mcp-server/operations.js";
import { WorkflowMcpSessionResolver } from "../mcp-server/index.js";
import { createProductionComposition } from "./composition.js";
import {
  prepareProductionFixture,
  SyntheticT3,
  type ProductionFixture,
} from "./composition.test-support.js";

const execute = promisify(execFile);
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

/** implement → confirm (question to the operator) → closed, or back to implement. */
const installQuestionBlueprint = async (
  fixture: ProductionFixture,
  role: "adjudicator" | "operator" = "operator",
): Promise<void> => {
  const path = join(
    fixture.blueprintsRepositoryRoot,
    "blueprints",
    "sample.json",
  );
  const blueprint = JSON.parse(await readFile(path, "utf8")) as {
    edges: unknown[];
    nodes: Array<Record<string, unknown>>;
  };
  const implement = blueprint.nodes.find(({ id }) => id === "implement")!;
  implement["config"] = { joinStrategy: "any" };
  blueprint.nodes = [
    { id: "begin", uses: "complete" },
    implement,
    {
      config: { joinStrategy: "any" },
      id: "confirm",
      params: {
        questions: [
          {
            header: "Sample delivery",
            id: "serve",
            options: [
              { description: "Finish the sample", label: "yes" },
              { description: "Rework the sample", label: "no" },
            ],
            question:
              "Serve task {{ task.id }} after {{ lifecycle.current.node }}?",
          },
        ],
        role,
      },
      uses: "question",
    },
    { id: "closed", uses: "complete" },
  ];
  blueprint.edges = [
    { source: "begin", target: "implement" },
    {
      condition: "result.output.dispositions.complete",
      description: "Complete the sample",
      disposition: "complete",
      source: "implement",
      target: "confirm",
    },
    {
      condition: "result.output.selected.serve.yes",
      source: "confirm",
      target: "closed",
    },
    {
      condition: "result.output.selected.serve.no",
      source: "confirm",
      target: "implement",
    },
  ];
  await writeFile(path, `${JSON.stringify(blueprint, null, 2)}\n`);
  await execute("git", ["add", "blueprints/sample.json"], {
    cwd: fixture.blueprintsRepositoryRoot,
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
      "Ask before finalizing",
    ],
    { cwd: fixture.blueprintsRepositoryRoot },
  );
  await execute("git", ["push", "--quiet"], {
    cwd: fixture.blueprintsRepositoryRoot,
  });
};

const compose = (fixture: ProductionFixture, t3 = new SyntheticT3()) =>
  createProductionComposition({
    blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
    configuration: fixture.configuration,
    providerUsage: {
      readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
    },
    pushoverTransport: { send: vi.fn(async () => undefined) },
    t3,
    workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
  });

const answer = (label: "no" | "yes") => ({
  serve: { reasoning: "Sample decision", selectedOptions: [label], text: "" },
});

const projectionOf = (
  composition: ReturnType<typeof compose>,
  instanceId: string,
) =>
  lifecycleProjectionOf(
    readLifecycleContext(composition.persistence.getInstance(instanceId)!),
  );

describe("production question node", () => {
  it("asks the operator with rendered text, then routes on the answer", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    await installQuestionBlueprint(fixture);
    const composition = compose(fixture);
    const instanceId = `task-${fixture.taskId}`;
    await composition.start();
    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId,
      operationId: advanceOperationId(`${instanceId}:implement:1`),
    });
    await composition.scheduler.trigger();

    const pending = composition.escalation.pendingEscalations(instanceId);
    expect(pending).toEqual([
      expect.objectContaining({
        answeringAuthority: { kind: "operator" },
        escalationId: "question:confirm:1",
        ownerSessionKey: "question:confirm:1",
        question: { nodeId: "confirm", visit: 1 },
        questions: [
          expect.objectContaining({
            header: "Sample delivery",
            id: "serve",
            question: `Serve task ${fixture.taskId} after implement?`,
          }),
        ],
        stage: "confirm",
      }),
    ]);
    expect(
      composition.attention.list().filter(({ kind }) => kind === "escalation"),
    ).toHaveLength(1);
    const waiting = composition.persistence
      .listReconcilerRuntime()
      .find((runtime) => runtime.instanceId === instanceId);
    expect(waiting).toMatchObject({ stageId: "confirm", state: "waiting" });
    // The runtime waits on a role, not on the implement stage's session.
    expect(waiting?.sessionKey).toBeUndefined();
    expect(waiting?.threadId).toBeUndefined();
    expect(waiting?.provider).toBeUndefined();
    expect(
      composition.persistence
        .listSessionRuntime()
        .filter((session) => session.instanceId === instanceId),
    ).toHaveLength(1);

    await composition.escalation.answerAsOperator({
      answers: answer("yes"),
      escalationId: "question:confirm:1",
      instanceId,
      ownerSessionKey: "question:confirm:1",
      prose: "Ship it",
    });
    expect(
      readLifecycleContext(composition.persistence.getInstance(instanceId)!),
    ).toMatchObject({ awaitingNodeIds: [], status: "completed" });
    expect(projectionOf(composition, instanceId).outputs["confirm"]).toEqual({
      answeredBy: { kind: "operator" },
      answers: answer("yes"),
      disposition: "answered",
      dispositions: { answered: true },
      prose: "Ship it",
      selected: { serve: { yes: true } },
    });
    expect(composition.escalation.pendingEscalations(instanceId)).toEqual([]);

    // Immediate replay: the same answer is inert, a different one is refused.
    await expect(
      composition.escalation.answerAsOperator({
        answers: answer("yes"),
        escalationId: "question:confirm:1",
        instanceId,
        ownerSessionKey: "question:confirm:1",
        prose: "Ship it",
      }),
    ).resolves.toBeDefined();
    await expect(
      composition.escalation.answerAsOperator({
        answers: answer("no"),
        escalationId: "question:confirm:1",
        instanceId,
        ownerSessionKey: "question:confirm:1",
      }),
    ).rejects.toThrow(/already answered differently/);
    expect(
      readLifecycleContext(composition.persistence.getInstance(instanceId)!),
    ).toMatchObject({ status: "completed" });
    await composition.close();
  });

  it("binds each answer to its own occurrence when the question recurs", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    await installQuestionBlueprint(fixture);
    const composition = compose(fixture);
    const instanceId = `task-${fixture.taskId}`;
    await composition.start();
    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId,
      operationId: advanceOperationId(`${instanceId}:implement:1`),
    });
    await composition.scheduler.trigger();
    await composition.escalation.answerAsOperator({
      answers: answer("no"),
      escalationId: "question:confirm:1",
      instanceId,
      ownerSessionKey: "question:confirm:1",
    });
    expect(
      readLifecycleContext(composition.persistence.getInstance(instanceId)!),
    ).toMatchObject({ awaitingNodeIds: ["implement"] });
    await composition.scheduler.trigger();
    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId,
      operationId: advanceOperationId(`${instanceId}:implement:2`),
    });
    await composition.scheduler.trigger();
    expect(
      composition.escalation
        .pendingEscalations(instanceId)
        .map(({ escalationId, question }) => [escalationId, question]),
    ).toEqual([["question:confirm:2", { nodeId: "confirm", visit: 2 }]]);
    expect(projectionOf(composition, instanceId).visits).toMatchObject({
      confirm: 1,
      implement: 2,
    });

    // Replay after recurrence: the first occurrence's answer cannot move the
    // second occurrence.
    await composition.escalation.answerAsOperator({
      answers: answer("no"),
      escalationId: "question:confirm:1",
      instanceId,
      ownerSessionKey: "question:confirm:1",
    });
    expect(
      readLifecycleContext(composition.persistence.getInstance(instanceId)!),
    ).toMatchObject({ awaitingNodeIds: ["confirm"] });
    expect(composition.escalation.pendingEscalations(instanceId)).toHaveLength(
      1,
    );

    await composition.escalation.answerAsOperator({
      answers: answer("yes"),
      escalationId: "question:confirm:2",
      instanceId,
      ownerSessionKey: "question:confirm:2",
    });
    expect(
      readLifecycleContext(composition.persistence.getInstance(instanceId)!),
    ).toMatchObject({ status: "completed" });
    await composition.close();
  });

  it("holds an adjudicator question when the deployment composes no adjudication", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    delete fixture.configuration.adjudication;
    await installQuestionBlueprint(fixture, "adjudicator");
    const composition = compose(fixture);
    const instanceId = `task-${fixture.taskId}`;
    await composition.start();
    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId,
      operationId: advanceOperationId(`${instanceId}:implement:1`),
    });
    await composition.scheduler.trigger();
    await composition.escalation.replayPendingRoutes();
    await composition.scheduler.trigger();

    // Nobody is asked in the adjudicator's place; the operator sees why.
    expect(composition.escalation.pendingEscalations(instanceId)).toEqual([]);
    const held = composition.attention
      .list()
      .filter(({ kind }) => kind === "production-error");
    expect(held).toEqual([
      expect.objectContaining({
        attentionId: `lifecycle:question-role:${instanceId}:confirm:1`,
        kind: "production-error",
        message: expect.stringContaining(
          'Question node "confirm" asks the adjudicator, and this deployment composes no adjudication.',
        ),
      }),
    ]);
    expect(
      readLifecycleContext(composition.persistence.getInstance(instanceId)!),
    ).toMatchObject({ awaitingNodeIds: ["confirm"], status: "awaiting" });
    expect(composition.persistence.listIncidentRuntime()).toEqual([]);
    await composition.close();

    // Composing adjudication and restarting asks the adjudicator.
    fixture.configuration.adjudication = {
      policyPath: "adjudication/policy.json",
      providerAlias: "primary",
    };
    const second = compose(fixture);
    await second.start();
    await second.scheduler.trigger();
    await second.escalation.replayPendingRoutes();
    expect(second.escalation.pendingEscalations(instanceId)).toEqual([
      expect.objectContaining({
        answeringAuthority: expect.objectContaining({ kind: "adjudication" }),
        question: { nodeId: "confirm", visit: 1 },
      }),
    ]);
    await second.close();
  });

  it("asks the adjudicator and takes its answer as the node's output", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    // No policyPath: the decision boundary comes from the conventional
    // location in the blueprint repository.
    fixture.configuration.adjudication = { providerAlias: "primary" };
    await installQuestionBlueprint(fixture, "adjudicator");
    const composition = compose(fixture);
    const instanceId = `task-${fixture.taskId}`;
    await composition.start();
    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId,
      operationId: advanceOperationId(`${instanceId}:implement:1`),
    });
    await composition.scheduler.trigger();
    await composition.escalation.replayPendingRoutes();

    expect(composition.escalation.pendingEscalations(instanceId)).toEqual([
      expect.objectContaining({
        answeringAuthority: expect.objectContaining({ kind: "adjudication" }),
        question: { nodeId: "confirm", visit: 1 },
      }),
    ]);
    expect(
      composition.attention.list().filter(({ kind }) => kind === "escalation"),
    ).toEqual([]);
    const adjudication = composition.persistence
      .listSessionRuntime()
      .find(
        (session) =>
          session.instanceId === instanceId && session.kind === "adjudication",
      );
    expect(adjudication).toBeDefined();
    // Adjudication decides; it does not change a repository, so it runs
    // approval-required whatever the configured default runtime mode is.
    expect(adjudication!.binding.runtimeMode).toBe("approval-required");
    expect(fixture.configuration.session.defaultRuntimeMode).not.toBe(
      "approval-required",
    );
    const binding = await new WorkflowMcpSessionResolver(
      composition.persistence,
    ).resolve(
      composition.persistence.getInstance(instanceId)!.state.correlationTokens[
        adjudication!.sessionKey
      ]!,
    );
    await composition.escalation.answerAsSession(binding, {
      answers: answer("yes"),
      escalationId: "question:confirm:1",
      ownerSessionKey: "question:confirm:1",
    });
    expect(
      readLifecycleContext(composition.persistence.getInstance(instanceId)!),
    ).toMatchObject({ status: "completed" });
    expect(
      projectionOf(composition, instanceId).outputs["confirm"],
    ).toMatchObject({
      answeredBy: {
        kind: "adjudication",
        sessionKey: adjudication!.sessionKey,
      },
      selected: { serve: { yes: true } },
    });
    await composition.close();
  });

  it("renders the conventional decision boundary into the adjudicator handoff", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    fixture.configuration.adjudication = { providerAlias: "primary" };
    await installQuestionBlueprint(fixture, "adjudicator");
    const composition = compose(fixture);
    const instanceId = `task-${fixture.taskId}`;
    await composition.start();
    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId,
      operationId: advanceOperationId(`${instanceId}:implement:1`),
    });
    await composition.scheduler.trigger();
    await composition.escalation.replayPendingRoutes();

    const policy = JSON.parse(
      await readFile(
        join(fixture.blueprintsRepositoryRoot, "adjudication", "policy.json"),
        "utf8",
      ),
    ) as {
      "decision-boundary": {
        decide: string[];
        escalate: string[];
        test: string;
      };
    };
    const adjudication = composition.persistence
      .listSessionRuntime()
      .find(
        (session) =>
          session.instanceId === instanceId && session.kind === "adjudication",
      );
    const handoff = composition.persistence
      .getInstance(instanceId)!
      .state.handoffs.find(
        (stored) => stored.sessionKey === adjudication!.sessionKey,
      );
    expect(handoff?.renderedHandoff).toContain(
      policy["decision-boundary"].decide[0]!,
    );
    expect(handoff?.renderedHandoff).toContain(
      policy["decision-boundary"].escalate[0]!,
    );
    expect(handoff?.renderedHandoff).toContain(
      `Decision test: ${policy["decision-boundary"].test}`,
    );
    await composition.close();
  });

  it("records the policy blob an adjudication opened with, not its path", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    fixture.configuration.adjudication = { providerAlias: "primary" };
    await installQuestionBlueprint(fixture, "adjudicator");
    const first = compose(fixture);
    const instanceId = `task-${fixture.taskId}`;
    await first.start();
    await first.lifecycle.resume({
      disposition: "complete",
      instanceId,
      operationId: advanceOperationId(`${instanceId}:implement:1`),
    });
    await first.scheduler.trigger();
    await first.escalation.replayPendingRoutes();
    const opened = first.persistence
      .getInstance(instanceId)!
      .state.handoffs.find(
        (stored) =>
          typeof stored === "object" &&
          stored !== null &&
          !Array.isArray(stored) &&
          stored["kind"] === "adjudication-handoff",
      );
    expect(opened).toBeDefined();
    const openedBlobHash = (
      await execute("git", ["rev-parse", "HEAD:adjudication/policy.json"], {
        cwd: fixture.blueprintsRepositoryRoot,
      })
    ).stdout.trim();
    await first.close();

    // The boundary moves under the open occurrence.
    const policyPath = join(
      fixture.blueprintsRepositoryRoot,
      "adjudication",
      "policy.json",
    );
    const policy = JSON.parse(await readFile(policyPath, "utf8")) as {
      "decision-boundary": { test: string };
    };
    policy["decision-boundary"].test = "A different decision test.";
    await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    await execute("git", ["add", "adjudication"], {
      cwd: fixture.blueprintsRepositoryRoot,
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
        "Change the decision boundary",
      ],
      { cwd: fixture.blueprintsRepositoryRoot },
    );
    await execute("git", ["push", "--quiet"], {
      cwd: fixture.blueprintsRepositoryRoot,
    });

    const second = compose(fixture);
    await second.start();
    await second.scheduler.trigger();
    await second.escalation.replayPendingRoutes();

    const retained = second.persistence
      .getInstance(instanceId)!
      .state.handoffs.filter(
        (stored) =>
          typeof stored === "object" &&
          stored !== null &&
          !Array.isArray(stored) &&
          stored["kind"] === "adjudication-handoff",
      );
    // One occurrence, one boundary: the record names the blob it opened with,
    // so a later edit at the same path cannot become this occurrence's policy.
    expect(retained).toEqual([opened]);
    const document = JSON.parse(
      (opened as Record<string, string>)["handoff"]!,
    ) as { policy: { blobHash: string; path: string } };
    expect(document.policy.path).toBe("adjudication/policy.json");
    expect(document.policy.blobHash).toBe(openedBlobHash);
    expect(openedBlobHash).not.toBe(
      (
        await execute("git", ["rev-parse", "HEAD:adjudication/policy.json"], {
          cwd: fixture.blueprintsRepositoryRoot,
        })
      ).stdout.trim(),
    );
    expect(JSON.stringify(retained)).not.toContain(
      "A different decision test.",
    );
    await second.close();
  });

  it("re-raises the pending question after a restart and accepts one answer", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    await installQuestionBlueprint(fixture);
    const first = compose(fixture);
    const instanceId = `task-${fixture.taskId}`;
    await first.start();
    await first.lifecycle.resume({
      disposition: "complete",
      instanceId,
      operationId: advanceOperationId(`${instanceId}:implement:1`),
    });
    await first.scheduler.trigger();
    expect(first.escalation.pendingEscalations(instanceId)).toHaveLength(1);
    await first.close();

    const second = compose(fixture);
    await second.start();
    await second.scheduler.trigger();
    expect(second.escalation.pendingEscalations(instanceId)).toEqual([
      expect.objectContaining({ escalationId: "question:confirm:1" }),
    ]);
    expect(
      second.attention.list().filter(({ kind }) => kind === "escalation"),
    ).toHaveLength(1);
    await second.escalation.answerAsOperator({
      answers: answer("yes"),
      escalationId: "question:confirm:1",
      instanceId,
      ownerSessionKey: "question:confirm:1",
    });
    expect(
      readLifecycleContext(second.persistence.getInstance(instanceId)!),
    ).toMatchObject({ status: "completed" });
    await second.close();
  });
});
