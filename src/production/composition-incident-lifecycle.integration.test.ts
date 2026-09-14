// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readLifecycleContext } from "../engine/index.js";
import { createProductionComposition } from "./composition.js";
import {
  prepareProductionFixture,
  SyntheticT3,
  type ProductionFixture,
} from "./composition.test-support.js";
import { productionErrorAttention } from "./error-visibility.js";

const execute = promisify(execFile);
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const levels = '{"low":0,"moderate":1,"high":2,"critical":3}';
const needsApproval =
  `$count(lifecycle.outputs.diagnose.proposedActions[kind = "production-mutation" and ` +
  `($not($exists(severity)) or $not(severity in ["low","moderate","high","critical"]) or ` +
  `$lookup(${levels}, severity) >= $lookup(${levels}, $$.lifecycle.blueprint.metadata.approvalSeverityThreshold))]) > 0`;

const commit = async (root: string, paths: string[], message: string) => {
  await execute("git", ["add", ...paths], { cwd: root });
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
      message,
    ],
    { cwd: root },
  );
};

/**
 * The incident lifecycle with no stage name read by Heddle: guards bound the
 * review loop, a question node asks the operator about production changes,
 * fail nodes end the incident, and resolve-attention closes the source.
 */
const installIncidentBlueprint = async (
  fixture: ProductionFixture,
): Promise<void> => {
  const root = fixture.blueprintsRepositoryRoot;
  await writeFile(
    join(root, "handoff-templates/incident.md"),
    [
      "---",
      "$schema: https://wyrd.company/heddle/handoff-template.schema.json",
      "relationships:",
      "  implements: heddle",
      "format: heddle.handoff-template",
      "version: 1",
      "---",
      "# Incident {{ handoff.taskContract.incident.incidentId }} at {{ handoff.stage.name }}",
      "",
    ].join("\n"),
  );
  await commit(root, ["handoff-templates/incident.md"], "Add incident handoff");
  const templateCommit = (
    await execute("git", ["rev-parse", "HEAD"], { cwd: root })
  ).stdout.trim();
  const stage = (id: string) => ({
    config: { joinStrategy: "any" },
    "handoff-template": {
      commitSha: templateCommit,
      path: "handoff-templates/incident.md",
    },
    id,
    "todo-template": "sample-stage",
    tools: ["advance"],
    uses: "wait",
  });
  await writeFile(
    join(root, "blueprints/incident.json"),
    `${JSON.stringify(
      {
        $schema: "https://wyrd.company/heddle/lifecycle-blueprint.schema.json",
        metadata: {
          approvalSeverityThreshold: "high",
          maximumReviewRejections: 2,
        },
        relationships: { implements: "heddle", uses: ["sample-stage"] },
        nodes: [
          { id: "begin", uses: "complete" },
          stage("diagnose"),
          stage("assess"),
          {
            id: "exhausted",
            params: {
              message:
                "Review rejected the diagnosis {{ lifecycle.visits.assess }} times",
            },
            uses: "fail",
          },
          {
            config: { joinStrategy: "any" },
            id: "confirm",
            params: {
              questions: [
                {
                  id: "apply",
                  options: [{ label: "yes" }, { label: "no" }],
                  question:
                    "Apply {{ lifecycle.outputs.diagnose.proposedActions[0].summary }}?",
                },
              ],
              role: "operator",
            },
            uses: "question",
          },
          {
            id: "declined",
            params: { message: "The operator declined the proposal" },
            uses: "fail",
          },
          { ...stage("act"), config: undefined },
          { id: "resolve", uses: "resolve-attention" },
          { id: "closed", uses: "complete" },
        ].map((node) =>
          Object.fromEntries(
            Object.entries(node).filter(([, value]) => value !== undefined),
          ),
        ),
        edges: [
          { source: "begin", target: "diagnose" },
          {
            description: "Submit the diagnosis",
            disposition: "diagnosed",
            source: "diagnose",
            target: "assess",
          },
          {
            condition:
              "result.output.dispositions.reject and lifecycle.visits.assess < lifecycle.blueprint.metadata.maximumReviewRejections",
            description: "Return the diagnosis",
            disposition: "reject",
            source: "assess",
            target: "diagnose",
          },
          {
            condition:
              "result.output.dispositions.reject and lifecycle.visits.assess >= lifecycle.blueprint.metadata.maximumReviewRejections",
            description: "Return the diagnosis",
            disposition: "reject",
            source: "assess",
            target: "exhausted",
          },
          {
            condition: `result.output.dispositions.approve and ${needsApproval}`,
            description: "Accept the diagnosis",
            disposition: "approve",
            source: "assess",
            target: "confirm",
          },
          {
            condition: `result.output.dispositions.approve and $not(${needsApproval})`,
            description: "Accept the diagnosis",
            disposition: "approve",
            source: "assess",
            target: "act",
          },
          {
            condition: "result.output.selected.apply.yes",
            source: "confirm",
            target: "act",
          },
          {
            condition: "result.output.selected.apply.no",
            source: "confirm",
            target: "declined",
          },
          {
            description: "Complete the accepted actions",
            disposition: "complete",
            source: "act",
            target: "resolve",
          },
          { source: "resolve", target: "closed" },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await commit(root, ["blueprints/incident.json"], "Add incident lifecycle");
  await execute("git", ["push", "--quiet"], { cwd: root });
};

const raiseIncident = async () => {
  const fixture = await prepareProductionFixture();
  cleanup = fixture.cleanup;
  fixture.configuration.incident = {
    failureThreshold: 1,
    githubIssueRepository: "sample-owner/sample-repository",
    retryDelayMilliseconds: 1_000,
    workspaceRoot: fixture.root,
  };
  // Synthetic threads stay active, so the WIP limit must admit every stage.
  fixture.configuration.pacing.maxConcurrentSessions = 10;
  await installIncidentBlueprint(fixture);
  const compose = () =>
    createProductionComposition({
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
    });
  const composition = compose();
  await composition.start();
  // A code no reconciler pass resolves on its own, so only the blueprint's
  // resolve-attention node can close it.
  const source = productionErrorAttention({
    code: "sample-condition-observed",
    error: new Error("Synthetic incident condition"),
    summary: "Sample incident condition",
    taskId: fixture.taskId,
  });
  await composition.attention.raise(source);
  await composition.scheduler.trigger();
  const incident = composition.persistence.listIncidentRuntime()[0]!;
  expect(incident).toMatchObject({ stageId: "diagnose", state: "waiting" });
  const advance = async (
    disposition: string,
    output?: Record<string, unknown>,
  ) => {
    const stage = composition.persistence.listIncidentRuntime()[0]!.stageId;
    const activation = composition.persistence
      .listSessionRuntime()
      .filter((session) => session.instanceId === incident.incidentId)
      .filter((session) => session.stageId === stage).length;
    await composition.lifecycle.resume({
      disposition,
      instanceId: incident.incidentId,
      operationId: `${incident.incidentId}:${stage}:${activation}:advance`,
      ...(output === undefined ? {} : { output }),
    });
    await settle();
  };
  // Activation of a successor stage is paced across passes; run the
  // scheduler until the incident is waiting or finished.
  const settle = async () => {
    for (let pass = 0; pass < 4; pass += 1) {
      await composition.scheduler.trigger();
      const state = composition.persistence.listIncidentRuntime()[0]!.state;
      if (state !== "starting") return;
    }
  };
  const runtime = () => composition.persistence.listIncidentRuntime()[0]!;
  const diagnosis = (severity?: string) => ({
    conditionState: "live",
    proposedActions:
      severity === undefined
        ? [{ kind: "github-issue", summary: "Record the condition" }]
        : [
            {
              kind: "production-mutation",
              severity,
              summary: "Restart the sample worker",
            },
          ],
    rootCauseAnalysis: "A sample dependency was unavailable",
  });
  return {
    advance,
    compose,
    composition,
    diagnosis,
    fixture,
    incident,
    runtime,
    settle,
    source,
  };
};

describe("production incident lifecycle", () => {
  it("runs diagnosis, assessment, and action, then resolves its source attention", async () => {
    const { advance, composition, diagnosis, incident, runtime, source } =
      await raiseIncident();
    await advance("diagnosed", diagnosis());
    expect(runtime()).toMatchObject({ stageId: "assess", state: "waiting" });
    await advance("approve");
    expect(runtime()).toMatchObject({ stageId: "act", state: "waiting" });
    await advance("complete", { conditionState: "cleared" });

    expect(runtime()).toMatchObject({ state: "done" });
    expect(
      readLifecycleContext(
        composition.persistence.getInstance(incident.incidentId)!,
      ),
    ).toMatchObject({ status: "completed" });
    expect(composition.persistence.getAttention(source.attentionId)).toEqual(
      expect.objectContaining({
        resolutionJustification: incident.incidentId,
        resolvedAt: expect.any(String),
      }),
    );
    await composition.close();
  });

  it("asks the operator about a production change and acts only on yes", async () => {
    const { advance, composition, diagnosis, incident, runtime, settle } =
      await raiseIncident();
    await advance("diagnosed", diagnosis("high"));
    await advance("approve");

    expect(runtime()).toMatchObject({ stageId: "confirm", state: "waiting" });
    const pending = composition.escalation.pendingEscalations(
      incident.incidentId,
    );
    expect(pending).toEqual([
      expect.objectContaining({
        question: { nodeId: "confirm", visit: 1 },
        questions: [
          expect.objectContaining({
            question: "Apply Restart the sample worker?",
          }),
        ],
      }),
    ]);
    await composition.escalation.answerAsOperator({
      answers: {
        apply: { reasoning: "Sample", selectedOptions: ["yes"], text: "" },
      },
      escalationId: pending[0]!.escalationId,
      instanceId: incident.incidentId,
      ownerSessionKey: pending[0]!.ownerSessionKey,
    });
    await settle();
    expect(runtime()).toMatchObject({ stageId: "act", state: "waiting" });
    await composition.close();
  });

  it("ends the incident as failed when the operator declines", async () => {
    const { advance, composition, diagnosis, incident, runtime, settle } =
      await raiseIncident();
    await advance("diagnosed", diagnosis("critical"));
    await advance("approve");
    const pending = composition.escalation.pendingEscalations(
      incident.incidentId,
    )[0]!;
    await composition.escalation.answerAsOperator({
      answers: {
        apply: { reasoning: "Sample", selectedOptions: ["no"], text: "" },
      },
      escalationId: pending.escalationId,
      instanceId: incident.incidentId,
      ownerSessionKey: pending.ownerSessionKey,
    });
    await settle();

    expect(runtime()).toMatchObject({ state: "failed" });
    expect(composition.attention.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attentionId: `lifecycle:failed:${incident.incidentId}:declined:1`,
          message: "The operator declined the proposal",
        }),
      ]),
    );
    await composition.close();
  });

  it("skips the question below the threshold and fails after the review bound", async () => {
    const { advance, composition, diagnosis, incident, runtime } =
      await raiseIncident();
    await advance("diagnosed", diagnosis("low"));
    await advance("reject", {
      findings: [{ summary: "Insufficient evidence" }],
    });
    expect(runtime()).toMatchObject({ stageId: "diagnose", state: "waiting" });
    await advance("diagnosed", diagnosis("low"));
    await advance("reject", { findings: [{ summary: "Still insufficient" }] });

    expect(runtime()).toMatchObject({ state: "failed" });
    expect(composition.attention.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attentionId: `lifecycle:failed:${incident.incidentId}:exhausted:1`,
          message: "Review rejected the diagnosis 2 times",
        }),
      ]),
    );
    await composition.close();
  });

  it("finishes an incident after a restart between its resolution and its synchronization", async () => {
    const {
      advance,
      compose,
      composition,
      diagnosis,
      incident,
      runtime,
      source,
    } = await raiseIncident();
    await advance("diagnosed", diagnosis());
    await advance("approve");
    expect(runtime()).toMatchObject({ stageId: "act", state: "waiting" });
    // The lifecycle completes — the resolve node closes the source — but the
    // process dies before the incident runtime is synchronized.
    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId: incident.incidentId,
      operationId: `${incident.incidentId}:act:1:advance`,
      output: { conditionState: "cleared" },
    });
    expect(
      composition.persistence.getAttention(source.attentionId),
    ).toMatchObject({
      resolutionJustification: incident.incidentId,
    });
    expect(runtime()).toMatchObject({ stageId: "act", state: "waiting" });
    await composition.close();

    const restarted = compose();
    await restarted.start();
    expect(restarted.persistence.listIncidentRuntime()[0]).toMatchObject({
      incidentId: incident.incidentId,
      state: "done",
    });
    expect(
      restarted.attention
        .list()
        .filter(({ taskId }) => taskId === incident.taskId),
    ).toEqual([]);
    await restarted.close();
  });

  it("acts without asking when the mutation is below the threshold", async () => {
    const { advance, composition, diagnosis, runtime } = await raiseIncident();
    await advance("diagnosed", diagnosis("moderate"));
    await advance("approve");
    expect(runtime()).toMatchObject({ stageId: "act", state: "waiting" });
    expect(
      composition.escalation.pendingEscalations(runtime().incidentId),
    ).toEqual([]);
    await composition.close();
  });
});
