// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkflowMcpSessionResolver } from "../mcp-server/index.js";
import { validateResolvedProductionConfiguration } from "./configuration.js";
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

const setStageReasoningEffort = async (
  fixture: ProductionFixture,
  reasoningEffort: string,
): Promise<void> => {
  const path = join(
    fixture.blueprintsRepositoryRoot,
    "blueprints",
    "sample.json",
  );
  const blueprint = JSON.parse(await readFile(path, "utf8")) as {
    nodes: Array<Record<string, unknown> & { id: string }>;
  };
  blueprint.nodes.find(({ id }) => id === "implement")!["reasoning-effort"] =
    reasoningEffort;
  await writeFile(path, `${JSON.stringify(blueprint, null, 2)}\n`);
  // The lifecycle pins blueprint content from git, so an uncommitted edit is
  // invisible to the running service.
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
      "Set a stage reasoning effort",
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
