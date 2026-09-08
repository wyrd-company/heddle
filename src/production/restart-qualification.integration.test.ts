// ---
// relationships:
//   verifies: heddle
//   references: t3-headless
// ---

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import { KanbanBoardAdapter } from "../board-adapter/index.js";
import {
  ProviderSelectionResolver,
  steerStageSession,
  T3ControlPlaneClient,
  type T3DispatchCommand,
  type T3ProviderDispatchContext,
} from "../control-plane/index.js";
import { WorkflowMcpSessionResolver } from "../mcp-server/index.js";
import { escalationAttentionId } from "../mcp-server/escalation-contract.js";
import type { JsonValue } from "../persistence/index.js";
import { isTodoState } from "../todo/index.js";
import { prepareProductionFixture } from "./composition.test-support.js";
import {
  createProductionComposition,
  type ProductionT3Client,
} from "./composition.js";
import { resolveProductionConfiguration } from "./configuration.js";
import {
  makeQualificationScratch,
  qualificationAliases,
  QUALIFICATION_EXECUTION,
  QUALIFICATION_INSTANCES,
  QUALIFICATION_SECOND_DRIVER,
  readyProviderModels,
  startIsolatedT3,
} from "./driver-qualification.test-support.js";
import { providerContextFromBinding } from "./session-binding.js";

const t3Binary = process.env["HEDDLE_T3_INTEGRATION_BINARY"];
const operatorHome = process.env["HOME"] ?? "";

const teardown: Array<() => Promise<void>> = [];

afterEach(async () => {
  const pending = teardown.splice(0, teardown.length).reverse();
  for (const release of pending) await release();
});

const setTaskProviderAlias = async (
  boardDirectory: string,
  taskId: number,
  alias: string,
): Promise<void> => {
  const directory = join(boardDirectory, "tasks");
  const file = (await readdir(directory)).find((name) =>
    new RegExp(`^0*${taskId}-`).test(name),
  );
  if (file === undefined) throw new Error(`No task file for ${taskId}`);
  const path = join(directory, file);
  const source = await readFile(path, "utf8");
  await writeFile(
    path,
    source
      .replace(/^provider-alias:.*\n/m, "")
      .replace(/^---\n/, `---\nprovider-alias: ${alias}\n`),
  );
};

const storedCorrelationToken = (handoffs: JsonValue[]): string => {
  const stored = handoffs.find(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      value["kind"] === "stage-handoff" &&
      typeof value["correlationToken"] === "string",
  );
  if (
    typeof stored !== "object" ||
    stored === null ||
    Array.isArray(stored) ||
    typeof stored["correlationToken"] !== "string"
  ) {
    throw new Error("Activated stage has no correlation token");
  }
  return stored["correlationToken"];
};

const recordingT3 = (client: T3ControlPlaneClient) => {
  const dispatches: Array<{
    command: T3DispatchCommand;
    providerContext?: T3ProviderDispatchContext;
  }> = [];
  const t3: ProductionT3Client & {
    readProviderCatalog: T3ControlPlaneClient["readProviderCatalog"];
  } = {
    dispatch: async (command, providerContext) => {
      dispatches.push({
        command,
        ...(providerContext === undefined ? {} : { providerContext }),
      });
      return client.dispatch(command, providerContext);
    },
    getShell: () => client.getShell(),
    getThread: (threadId) => client.getThread(threadId),
    readProviderCatalog: () => client.readProviderCatalog(),
    registerWorkflowMcpProviderSession: (registration) =>
      client.registerWorkflowMcpProviderSession(registration),
    respondToApproval: (threadId, requestId, decision, commandId) =>
      client.respondToApproval(threadId, requestId, decision, commandId),
    respondToUserInput: (threadId, requestId, answers, commandId) =>
      client.respondToUserInput(threadId, requestId, answers, commandId),
  };
  return { dispatches, t3 };
};

describe.skipIf(!t3Binary)("restart with an active session", () => {
  it("retains mixed-provider bindings across restart for replay, steering, notification, and pacing", async () => {
    const scratch = await makeQualificationScratch();
    teardown.push(scratch.cleanup);
    const fixture = await prepareProductionFixture();
    teardown.push(fixture.cleanup);

    const isolated = await startIsolatedT3({
      binary: t3Binary as string,
      home: operatorHome,
      providerInstances: [...QUALIFICATION_INSTANCES],
      scratch: scratch.root,
    });
    teardown.push(isolated.stop);

    const client = new T3ControlPlaneClient({
      accessToken: isolated.accessToken,
      baseUrl: isolated.baseUrl,
    });
    const providerAliases = qualificationAliases(
      await readyProviderModels(client),
    );

    await writeFile(
      join(
        fixture.blueprintsRepositoryRoot,
        "todo-templates",
        "sample-stage.json",
      ),
      JSON.stringify({
        items: [
          { id: "deliver", text: "Deliver the sample" },
          { id: "verify", text: "Verify the sample" },
        ],
      }),
    );

    await client.dispatch({
      commandId: globalThis.crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      projectId: fixture.configuration.adHocProject.projectId,
      title: fixture.configuration.adHocProject.name,
      type: "project.create",
      workspaceRoot: fixture.repositoryRoot,
    });

    const baseConfiguration = {
      ...fixture.configuration,
      adHocProject: {
        ...fixture.configuration.adHocProject,
        workspaceRoot: fixture.repositoryRoot,
      },
      pacing: {
        ...fixture.configuration.pacing,
        maxConcurrentSessions: 4,
        providerBudgets: {
          execution: { usageLimit: 100 },
          secondary: { usageLimit: 100 },
        },
        subagents: { maxDepth: 1, maxFanOut: 2 },
      },
      providerAliases,
      session: {
        ...fixture.configuration.session,
        defaultProviderAlias: "execution",
      },
      t3: { accessToken: isolated.accessToken, baseUrl: isolated.baseUrl },
    };

    const configuration = await resolveProductionConfiguration(
      baseConfiguration,
      new ProviderSelectionResolver(providerAliases, client),
    );

    const firstT3 = recordingT3(client);
    const first = createProductionComposition({
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      resolveSystemPrompt: async () =>
        "# Restart qualification\n\nWait for a later turn. Do not call tools.",
      t3: firstT3.t3,
      workflowMcpEndpoint: `${isolated.baseUrl}/mcp`,
    });
    await first.start();

    const instanceId = `task-${fixture.taskId}`;
    const before = first.persistence.getInstance(instanceId);
    expect(before).toBeDefined();
    const firstResolver = new WorkflowMcpSessionResolver(first.persistence);
    const parent = await firstResolver.resolve(
      storedCorrelationToken(before!.state.handoffs),
    );
    const boundRuntime = first.persistence
      .listSessionRuntime()
      .find((entry) => entry.instanceId === instanceId);
    expect(boundRuntime).toBeDefined();
    expect(boundRuntime?.binding.providerInstanceId).toBe(
      QUALIFICATION_EXECUTION.instanceId,
    );
    const boundThreadId = boundRuntime?.threadId;
    if (boundThreadId === undefined) throw new Error("Parent thread is absent");
    const firstChild = await first.subagents.spawn(parent, {
      operationId: "restart-existing-child",
      providerAlias: "secondary",
      rootItemId: "deliver",
    });
    if (firstChild.kind !== "spawned") {
      throw new Error("Existing child was deferred");
    }
    expect(firstChild.assignment.binding.providerInstanceId).toBe(
      QUALIFICATION_SECOND_DRIVER.instanceId,
    );
    const child = await firstResolver.resolve(
      firstChild.assignment.correlationToken,
    );
    const escalationId = "restart-child-choice";
    const attentionId = escalationAttentionId(
      instanceId,
      child.sessionKey,
      escalationId,
    );
    first.persistence.appendEvent(instanceId, "mcp:escalation-opened", {
      attentionId,
      escalationId,
      instanceId,
      openedAt: "2026-01-01T00:00:00.000Z",
      ownerSessionKey: child.sessionKey,
      parentSessionKey: parent.sessionKey,
      questions: [
        {
          id: "selection",
          options: [
            {
              description: "Use the first sample",
              id: "first",
              label: "First",
            },
            {
              description: "Use the second sample",
              id: "second",
              label: "Second",
            },
          ],
          prompt: "Which sample should be selected?",
        },
      ],
      stage: child.stage.id,
    });
    const threadsBefore = (await client.getShell()).threads.length;
    await first.close();

    // The operator retargets the task while the session is already bound.
    await setTaskProviderAlias(
      fixture.configuration.boardDirectory,
      fixture.taskId,
      "secondary",
    );

    // Positive evidence that the retarget is real and live: the production
    // board reader returns it, and a fresh selection made from it resolves to
    // the other driver. Without this, the assertions below would hold even if
    // the front matter had never changed.
    const board = new KanbanBoardAdapter(fixture.configuration.boardDirectory);
    const retargeted = await board.readTask(fixture.taskId);
    expect(retargeted.providerAlias).toBe("secondary");
    const freshSelection = await new ProviderSelectionResolver(
      providerAliases,
      client,
    ).resolve(retargeted.providerAlias as string, {
      interactionMode: configuration.session.interactionMode,
      runtimeMode: configuration.session.defaultRuntimeMode,
    });
    expect(freshSelection.providerInstanceId).toBe(
      QUALIFICATION_SECOND_DRIVER.instanceId,
    );

    const pacedProviders: string[] = [];
    const secondT3 = recordingT3(client);
    const second = createProductionComposition({
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration,
      providerUsage: {
        readFiveHourWindow: async (provider) => {
          pacedProviders.push(provider);
          return { used: 0, windowStartedAt: 0 };
        },
      },
      resolveSystemPrompt: async () =>
        "# Restart qualification\n\nWait for a later turn. Do not call tools.",
      t3: secondT3.t3,
      workflowMcpEndpoint: `${isolated.baseUrl}/mcp`,
    });
    teardown.push(() => second.close());
    await second.start();

    const runtimeAfterReplay = second.persistence
      .listSessionRuntime()
      .filter((entry) => entry.instanceId === instanceId);

    // The parent runtime and delegated child assignment are replayed, not
    // duplicated. Child runtimes live in the todo assignment catalog.
    expect(runtimeAfterReplay).toHaveLength(1);
    expect(runtimeAfterReplay[0]?.threadId).toBe(boundThreadId);
    const replayedBeforeLaterSpawn = second.persistence.getInstance(instanceId);
    if (!isTodoState(replayedBeforeLaterSpawn?.state.todoState)) {
      throw new Error("Restarted instance has no todo state");
    }
    const assignmentsAfterReplay =
      replayedBeforeLaterSpawn.state.todoState.lists.flatMap(
        ({ assignments = [] }) => assignments,
      );
    expect(assignmentsAfterReplay).toHaveLength(1);
    expect(assignmentsAfterReplay[0]).toEqual(firstChild.assignment);
    expect((await client.getShell()).threads).toHaveLength(threadsBefore);

    // The existing thread keeps the provider it was bound to, even though the
    // task now names a different alias on a different driver.
    const parentAfter = runtimeAfterReplay.find(
      ({ sessionKey }) => sessionKey === parent.sessionKey,
    );
    const childAfter = assignmentsAfterReplay.find(
      ({ sessionKey }) => sessionKey === child.sessionKey,
    );
    if (parentAfter === undefined || childAfter === undefined) {
      throw new Error("Restart did not recover the mixed-provider sessions");
    }
    expect(parentAfter?.binding.providerInstanceId).toBe(
      QUALIFICATION_EXECUTION.instanceId,
    );
    expect(parentAfter?.binding.driverKind).toBe(
      QUALIFICATION_EXECUTION.driver,
    );
    expect(parentAfter?.binding.providerInstanceId).not.toBe(
      QUALIFICATION_SECOND_DRIVER.instanceId,
    );
    expect(parentAfter?.activation).toBe(boundRuntime?.activation);
    expect(childAfter.binding.providerInstanceId).toBe(
      QUALIFICATION_SECOND_DRIVER.instanceId,
    );
    expect(childAfter.binding.runtimeMode).toBe(
      firstChild.assignment.binding.runtimeMode,
    );

    // Recovery notifies the parent by steering its exact durable thread and
    // binding, rather than selecting the task's changed alias.
    expect(
      secondT3.dispatches.filter(
        ({ command }) =>
          command.type === "thread.turn.start" &&
          command["message"] !== undefined &&
          (command["message"] as { text?: string }).text ===
            `Child escalation ${attentionId} requires an answer`,
      ),
    ).toEqual([
      {
        command: expect.objectContaining({
          interactionMode: parentAfter?.binding.interactionMode,
          runtimeMode: parentAfter?.binding.runtimeMode,
          threadId: parentAfter?.threadId,
          type: "thread.turn.start",
        }),
        providerContext: providerContextFromBinding(parentAfter.binding),
      },
    ]);

    // A later explicit steer also uses the existing child's durable target.
    await steerStageSession(
      {
        interactionMode: childAfter.binding.interactionMode,
        message: "Continue the isolated restart qualification.",
        providerContext: providerContextFromBinding(childAfter.binding),
        runtimeMode: childAfter.binding.runtimeMode,
        threadId: childAfter.threadId,
      },
      { t3: secondT3.t3 },
    );
    expect(secondT3.dispatches.at(-1)).toMatchObject({
      command: {
        interactionMode: childAfter.binding.interactionMode,
        runtimeMode: childAfter.binding.runtimeMode,
        threadId: childAfter.threadId,
        type: "thread.turn.start",
      },
      providerContext: providerContextFromBinding(childAfter.binding),
    });

    const replayedParent = await new WorkflowMcpSessionResolver(
      second.persistence,
    ).resolve(parent.token);
    const laterChild = await second.subagents.spawn(replayedParent, {
      operationId: "restart-paced-child",
      providerAlias: "secondary",
      rootItemId: "verify",
    });
    if (laterChild.kind !== "spawned") {
      throw new Error("Later child was deferred");
    }
    expect(laterChild.assignment.binding.providerInstanceId).toBe(
      QUALIFICATION_SECOND_DRIVER.instanceId,
    );
    expect(laterChild.assignment.binding.runtimeMode).toBe(
      firstChild.assignment.binding.runtimeMode,
    );
    expect(pacedProviders).toEqual([QUALIFICATION_SECOND_DRIVER.instanceId]);

    const replayed = second.persistence.getInstance(instanceId);
    expect(replayed).toBeDefined();
    expect(isTodoState(replayed?.state.todoState)).toBe(true);
    if (!isTodoState(replayed?.state.todoState)) {
      throw new Error("Restarted instance has no todo state");
    }
    expect(
      replayed.state.todoState.lists.flatMap(
        ({ assignments = [] }) => assignments,
      ),
    ).toHaveLength(2);

    // Replay itself dispatched no duplicate thread into the control plane;
    // only the new, paced child adds one after the replay assertions.
    expect((await client.getShell()).threads).toHaveLength(threadsBefore + 1);
  }, 300_000);
});
