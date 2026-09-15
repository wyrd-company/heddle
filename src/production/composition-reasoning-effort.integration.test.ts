// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { advanceOperationId } from "../mcp-server/operations.js";
import { WorkflowMcpSessionResolver } from "../mcp-server/index.js";
import type { JsonValue } from "../persistence/index.js";
import { validateResolvedProductionConfiguration } from "./configuration.js";
import { createProductionComposition } from "./composition.js";
import {
  prepareProductionEpicFixture,
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

/** The synthetic workbench publishes a reasoning select, as a real one does. */
const offerReasoningEfforts = (t3: SyntheticT3): void => {
  t3.providerCatalog[0]!.models[0] = {
    ...t3.providerCatalog[0]!.models[0]!,
    optionDescriptors: [
      {
        id: "reasoningEffort",
        options: [{ id: "low" }, { id: "medium" }, { id: "xhigh" }],
        type: "select",
      },
    ],
  };
};

const setLifecycleReasoningEffort = async (
  fixture: ProductionFixture,
  reasoningEffort: string,
): Promise<void> => {
  const path = join(
    fixture.blueprintsRepositoryRoot,
    "blueprints",
    "sample.json",
  );
  const blueprint = JSON.parse(await readFile(path, "utf8")) as Record<
    string,
    unknown
  >;
  blueprint["reasoning-effort"] = reasoningEffort;
  await writeFile(path, `${JSON.stringify(blueprint, null, 2)}\n`);
  await commitBlueprints(fixture, "Set a lifecycle reasoning effort");
};

const setStageReasoningEffort = async (
  fixture: ProductionFixture,
  reasoningEffort: string,
  stageId = "implement",
): Promise<void> => {
  const path = join(
    fixture.blueprintsRepositoryRoot,
    "blueprints",
    "sample.json",
  );
  const blueprint = JSON.parse(await readFile(path, "utf8")) as {
    nodes: Array<Record<string, unknown> & { id: string }>;
  };
  blueprint.nodes.find(({ id }) => id === stageId)!["reasoning-effort"] =
    reasoningEffort;
  await writeFile(path, `${JSON.stringify(blueprint, null, 2)}\n`);
  await commitBlueprints(fixture, "Set a stage reasoning effort");
};

// The lifecycle pins blueprint content from git, so an uncommitted edit is
// invisible to the running service.
const commitBlueprints = async (
  fixture: ProductionFixture,
  message: string,
): Promise<void> => {
  await execute("git", ["add", "blueprints"], {
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
      message,
    ],
    { cwd: fixture.blueprintsRepositoryRoot },
  );
  await execute("git", ["push", "--quiet"], {
    cwd: fixture.blueprintsRepositoryRoot,
  });
};

const compose = (fixture: ProductionFixture, t3: SyntheticT3) =>
  createProductionComposition({
    workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
    blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
    configuration: fixture.configuration,
    providerUsage: {
      readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
    },
    pushoverTransport: { send: vi.fn(async () => undefined) },
    t3,
  });

const modelSelectionsOf = (t3: SyntheticT3, threadId?: string) =>
  t3.commands
    .filter(
      (command) =>
        (command["type"] === "thread.create" ||
          command["type"] === "thread.turn.start") &&
        (threadId === undefined || command["threadId"] === threadId),
    )
    .map((command) => command["modelSelection"]);

describe("production reasoning effort", () => {
  it("dispatches the configured alias effort on every stage session command", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    fixture.configuration.providerAliases = {
      primary: {
        model: "sample-model",
        providerDisplayName: "Workbench Alpha",
        reasoningEffort: "medium",
      },
    };
    const t3 = new SyntheticT3();
    offerReasoningEfforts(t3);
    const composition = compose(fixture, t3);

    await composition.start();

    expect(modelSelectionsOf(t3)).not.toEqual([]);
    for (const modelSelection of modelSelectionsOf(t3)) {
      expect(modelSelection).toMatchObject({
        instanceId: "codex",
        model: "sample-model",
        options: [{ id: "reasoningEffort", value: "medium" }],
      });
    }
    expect(
      composition.persistence
        .listSessionRuntime()
        .map(({ binding }) => binding.reasoningEffort),
    ).toEqual(["medium"]);
    await composition.close();
  });

  it("lets the blueprint stage override the configured alias effort", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    fixture.configuration.providerAliases = {
      primary: {
        model: "sample-model",
        providerDisplayName: "Workbench Alpha",
        reasoningEffort: "medium",
      },
    };
    await setStageReasoningEffort(fixture, "xhigh");
    const t3 = new SyntheticT3();
    offerReasoningEfforts(t3);
    const composition = compose(fixture, t3);

    await composition.start();

    for (const modelSelection of modelSelectionsOf(t3)) {
      expect(modelSelection).toMatchObject({
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      });
    }
    await composition.close();
  });

  it("dispatches no provider options when no layer configures an effort", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const t3 = new SyntheticT3();
    offerReasoningEfforts(t3);
    const composition = compose(fixture, t3);

    await composition.start();

    expect(modelSelectionsOf(t3)).not.toEqual([]);
    for (const modelSelection of modelSelectionsOf(t3)) {
      expect(modelSelection).not.toHaveProperty("options");
    }
    expect(
      composition.persistence
        .listSessionRuntime()
        .map(({ binding }) => binding),
    ).not.toContainEqual(
      expect.objectContaining({ reasoningEffort: expect.anything() }),
    );
    await composition.close();
  });

  it("runs the adjudication session at its configured alias effort", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    fixture.configuration.providerAliases = {
      primary: {
        model: "sample-model",
        providerDisplayName: "Workbench Alpha",
      },
      adjudicator: {
        model: "sample-model",
        providerDisplayName: "Workbench Alpha",
        reasoningEffort: "xhigh",
      },
    };
    fixture.configuration.adjudication = {
      policyPath: "adjudication/policy.json",
      providerAlias: "adjudicator",
    };
    const t3 = new SyntheticT3();
    offerReasoningEfforts(t3);
    const composition = compose(fixture, t3);
    await composition.start();
    const runtime = composition.persistence
      .listReconcilerRuntime()
      .find(({ state }) => state === "waiting")!;
    const owner = await new WorkflowMcpSessionResolver(
      composition.persistence,
    ).resolve(
      composition.persistence.getInstance(runtime.instanceId)!.state
        .correlationTokens[runtime.sessionKey!]!,
    );

    await composition.escalation.escalate(owner, {
      threadId: runtime.threadId!,
      requestId: "request-one",
      escalationId: "production-choice",
      questions: [
        {
          multiSelect: false,
          id: "selection",
          options: [
            { description: "Use the first generic option", label: "first" },
            { description: "Use the second generic option", label: "second" },
          ],
          question: "Which generic option should be selected?",
        },
      ],
    });
    await vi.waitFor(() =>
      expect(
        composition.persistence
          .listSessionRuntime()
          .filter(({ kind }) => kind === "adjudication"),
      ).toHaveLength(1),
    );

    const adjudication = composition.persistence
      .listSessionRuntime()
      .find(({ kind }) => kind === "adjudication")!;
    expect(adjudication.binding).toMatchObject({
      alias: "adjudicator",
      reasoningEffort: "xhigh",
      reasoningEffortOptionId: "reasoningEffort",
    });
    const adjudicationSelections = modelSelectionsOf(t3, adjudication.threadId);
    expect(adjudicationSelections).not.toEqual([]);
    for (const modelSelection of adjudicationSelections) {
      expect(modelSelection).toMatchObject({
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      });
    }
    // The owner's own session keeps the effort its alias configures — none.
    for (const modelSelection of modelSelectionsOf(t3, runtime.threadId!)) {
      expect(modelSelection).not.toHaveProperty("options");
    }
    await composition.close();
  });

  it("gives each stage its own effort as the lifecycle advances", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    await setStageReasoningEffort(fixture, "xhigh", "implement");
    await setStageReasoningEffort(fixture, "low", "review");
    const t3 = new SyntheticT3();
    offerReasoningEfforts(t3);
    const composition = compose(fixture, t3);
    const instanceId = `task-${fixture.taskId}`;
    await composition.start();
    const implementSession = composition.persistence
      .listSessionRuntime()
      .find(({ stageId }) => stageId === "implement")!;

    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId,
      operationId: advanceOperationId(`${instanceId}:implement:1`),
      output: { evidence: "sample" },
    });
    await composition.scheduler.trigger();

    const reviewSession = composition.persistence
      .listSessionRuntime()
      .find(({ stageId }) => stageId === "review");
    expect(reviewSession?.binding.reasoningEffort).toBe("low");
    for (const modelSelection of modelSelectionsOf(
      t3,
      implementSession.threadId,
    )) {
      expect(modelSelection).toMatchObject({
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      });
    }
    const reviewSelections = modelSelectionsOf(t3, reviewSession!.threadId);
    expect(reviewSelections).not.toEqual([]);
    for (const modelSelection of reviewSelections) {
      expect(modelSelection).toMatchObject({
        options: [{ id: "reasoningEffort", value: "low" }],
      });
    }
    await composition.close();
  });

  it("names the layer that set an unusable effort", async () => {
    const stageFixture = await prepareProductionFixture();
    cleanup = stageFixture.cleanup;
    await setStageReasoningEffort(stageFixture, "ultra", "implement");
    const stageT3 = new SyntheticT3();
    offerReasoningEfforts(stageT3);
    const stageComposition = compose(stageFixture, stageT3);

    await stageComposition.start();

    expect(
      stageComposition.attention.list().map(({ message }) => message),
    ).toContainEqual(
      expect.stringContaining("Stage 'implement' sets reasoning effort"),
    );
    await stageComposition.close();
    await stageFixture.cleanup();

    const headerFixture = await prepareProductionFixture();
    cleanup = headerFixture.cleanup;
    await setLifecycleReasoningEffort(headerFixture, "ultra");
    const headerT3 = new SyntheticT3();
    offerReasoningEfforts(headerT3);
    const headerComposition = compose(headerFixture, headerT3);

    await headerComposition.start();

    const headerMessages = headerComposition.attention
      .list()
      .map(({ message }) => message);
    expect(headerMessages).toContainEqual(
      expect.stringContaining("The lifecycle header sets reasoning effort"),
    );
    expect(headerMessages).not.toContainEqual(
      expect.stringContaining("Stage 'implement' sets reasoning effort"),
    );
    await headerComposition.close();
  });

  it("takes the lifecycle header effort when the stage sets none", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    await setLifecycleReasoningEffort(fixture, "medium");
    const t3 = new SyntheticT3();
    offerReasoningEfforts(t3);
    const composition = compose(fixture, t3);

    await composition.start();

    for (const modelSelection of modelSelectionsOf(t3)) {
      expect(modelSelection).toMatchObject({
        options: [{ id: "reasoningEffort", value: "medium" }],
      });
    }
    await composition.close();
  });

  it("refuses a resolved configuration whose default selection effort disagrees", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const { defaultSelection, resolvedSelections } =
      fixture.configuration.session;

    expect(() =>
      validateResolvedProductionConfiguration({
        ...fixture.configuration,
        session: {
          ...fixture.configuration.session,
          defaultSelection: {
            ...defaultSelection,
            reasoningEffort: "xhigh",
            reasoningEffortOptionId: "reasoningEffort",
          },
          resolvedSelections,
        },
      }),
    ).toThrow(
      "session.defaultSelection must be the default alias entry in session.resolvedSelections",
    );
  });

  it("gives a delegated child its own alias effort, not the stage's", async () => {
    // The blueprint layers scope one stage session. A child takes the effort of
    // the alias it is spawned with, so the two are set to different values here
    // and the child must show its alias's.
    const fixture = await prepareProductionEpicFixture();
    cleanup = fixture.cleanup;
    await setStageReasoningEffort(fixture, "xhigh", "implement");
    fixture.configuration.providerAliases = {
      ...fixture.configuration.providerAliases,
      delegate: {
        model: "sample-model",
        providerDisplayName: "Workbench Alpha",
        reasoningEffort: "low",
      },
    };
    const t3 = new SyntheticT3();
    offerReasoningEfforts(t3);
    const composition = compose(fixture, t3);
    cleanup = async () => {
      await composition.close();
      await fixture.cleanup();
    };
    await composition.start();
    const instanceId = `task-${fixture.taskId}`;
    const resolver = new WorkflowMcpSessionResolver(composition.persistence);
    const handoffs = composition.persistence.getInstance(instanceId)!.state
      .handoffs as JsonValue[];
    const stored = handoffs.find(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        value["kind"] === "stage-handoff" &&
        typeof value["correlationToken"] === "string",
    ) as { correlationToken: string };
    const parent = await resolver.resolve(stored.correlationToken);

    const spawned = await composition.subagents.spawn(parent, {
      operationId: "spawn-effort-child",
      providerAlias: "delegate",
      rootItemId: "deliver",
    });

    if (spawned.kind !== "spawned") throw new Error("Child was deferred");
    expect(spawned.assignment.binding).toMatchObject({
      alias: "delegate",
      reasoningEffort: "low",
      reasoningEffortOptionId: "reasoningEffort",
    });
    const childSelections = modelSelectionsOf(t3, spawned.assignment.threadId);
    expect(childSelections).not.toEqual([]);
    for (const modelSelection of childSelections) {
      expect(modelSelection).toMatchObject({
        options: [{ id: "reasoningEffort", value: "low" }],
      });
    }
  });

  it("makes an effort the model does not offer visible to the operator", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    fixture.configuration.providerAliases = {
      primary: {
        model: "sample-model",
        providerDisplayName: "Workbench Alpha",
        reasoningEffort: "ultra",
      },
    };
    const t3 = new SyntheticT3();
    offerReasoningEfforts(t3);
    const composition = compose(fixture, t3);

    await composition.start();

    expect(modelSelectionsOf(t3)).toEqual([]);
    expect(
      composition.attention.list().map(({ message }) => message),
    ).toContainEqual(
      expect.stringContaining(
        "model 'sample-model' offers 'low', 'medium', 'xhigh'",
      ),
    );
    await composition.close();
  });
});
