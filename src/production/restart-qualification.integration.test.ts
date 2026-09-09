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
} from "../control-plane/index.js";
import { resolveT3AwarenessPhase } from "../control-plane/t3-agent-awareness.js";
import { WorkflowMcpSessionResolver } from "../mcp-server/index.js";
import { escalationAttentionId } from "../mcp-server/escalation-contract.js";
import { isTodoState } from "../todo/index.js";
import { prepareProductionFixture } from "./composition.test-support.js";
import { createProductionComposition } from "./composition.js";
import { resolveProductionConfiguration } from "./configuration.js";
import {
  CONTROLLED_QUALIFICATION_EXECUTION,
  CONTROLLED_QUALIFICATION_INSTANCES,
  CONTROLLED_QUALIFICATION_REVIEW,
  CONTROLLED_QUALIFICATION_SECOND_DRIVER,
  makeQualificationScratch,
  qualificationAliases,
  readyProviderModels,
  startIsolatedT3,
} from "./driver-qualification.test-support.js";
import {
  recordingT3,
  storedCorrelationToken,
} from "./restart-qualification.test-support.js";
import { providerContextFromBinding } from "./session-binding.js";

const t3Binary = process.env["HEDDLE_T3_INTEGRATION_BINARY"];
const teardown: Array<() => Promise<void>> = [];

const waitForRunningThread = async (
  client: T3ControlPlaneClient,
  threadId: string,
): Promise<"running"> => {
  let lastPhase: string | undefined;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const thread = (await client.getShell()).threads.find(
      ({ id }) => id === threadId,
    );
    lastPhase =
      thread === undefined ? "absent" : resolveT3AwarenessPhase(thread);
    if (lastPhase === "running") return "running";
    if (lastPhase === "failed" || lastPhase === "completed") break;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  }
  throw new Error(
    `Thread '${threadId}' did not remain active for restart pacing; last phase '${lastPhase ?? "unknown"}'`,
  );
};

afterEach(async () => {
  const pending = teardown.splice(0, teardown.length).reverse();
  for (const release of pending) await release();
});

const setTaskProviderAlias = async (
  boardDirectory: string,
  taskId: number,
  stageId: string,
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
      .replace(/^provider-alias:(?:[^\n]*\n(?:[ \t]+[^\n]*\n)*)/m, "")
      .replace(/^---\n/, `---\nprovider-alias:\n  ${stageId}: ${alias}\n`),
  );
};

describe.skipIf(!t3Binary)("restart with an active session", () => {
  it("retains mixed-provider bindings across restart for replay, steering, notification, and pacing", async () => {
    const scratch = await makeQualificationScratch();
    teardown.push(scratch.cleanup);
    const fixture = await prepareProductionFixture();
    teardown.push(fixture.cleanup);

    const isolated = await startIsolatedT3({
      binary: t3Binary as string,
      providerInstances: [...CONTROLLED_QUALIFICATION_INSTANCES],
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
          review: { usageLimit: 100 },
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
      CONTROLLED_QUALIFICATION_EXECUTION.instanceId,
    );
    const boundThreadId = boundRuntime?.threadId;
    if (boundThreadId === undefined) throw new Error("Parent thread is absent");
    expect(await waitForRunningThread(client, boundThreadId)).toBe("running");
    const firstChild = await first.subagents.spawn(parent, {
      operationId: "restart-existing-child",
      providerAlias: "secondary",
      rootItemId: "deliver",
    });
    if (firstChild.kind !== "spawned") {
      throw new Error("Existing child was deferred");
    }
    expect(firstChild.assignment.binding.providerInstanceId).toBe(
      CONTROLLED_QUALIFICATION_SECOND_DRIVER.instanceId,
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
      "implement",
      "review",
    );

    // Positive evidence that the retarget is real and live: the production
    // board reader returns it, and a fresh selection made from it resolves to
    // a third provider instance. Without this, the assertions below would hold
    // even if the front matter had never changed.
    const board = new KanbanBoardAdapter(fixture.configuration.boardDirectory);
    const retargeted = await board.readTask(fixture.taskId);
    expect(retargeted.providerAlias).toEqual({ implement: "review" });
    const retargetedImplementAlias = retargeted.providerAlias?.["implement"];
    if (retargetedImplementAlias === undefined) {
      throw new Error("Retargeted implement alias is absent");
    }
    const freshSelection = await new ProviderSelectionResolver(
      providerAliases,
      client,
    ).resolve(retargetedImplementAlias, {
      interactionMode: configuration.session.interactionMode,
      runtimeMode: configuration.session.defaultRuntimeMode,
    });
    expect(freshSelection.providerInstanceId).toBe(
      CONTROLLED_QUALIFICATION_REVIEW.instanceId,
    );
    const restartDefault = configuration.session.resolvedSelections.find(
      ({ alias }) => alias === "review",
    );
    if (restartDefault === undefined) {
      throw new Error("Restart default selection is absent");
    }
    const restartedConfiguration = {
      ...configuration,
      pacing: {
        ...configuration.pacing,
        defaultProvider: restartDefault.providerInstanceId,
      },
      session: {
        ...configuration.session,
        defaultProviderAlias: "review",
        defaultSelection: restartDefault,
      },
    };

    const pacedProviders: string[] = [];
    const secondT3 = recordingT3(client);
    const second = createProductionComposition({
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: restartedConfiguration,
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
      CONTROLLED_QUALIFICATION_EXECUTION.instanceId,
    );
    expect(parentAfter?.binding.driverKind).toBe(
      CONTROLLED_QUALIFICATION_EXECUTION.driver,
    );
    expect(parentAfter?.binding.providerInstanceId).not.toBe(
      CONTROLLED_QUALIFICATION_REVIEW.instanceId,
    );
    expect(parentAfter?.activation).toBe(boundRuntime?.activation);
    expect(childAfter.binding.providerInstanceId).toBe(
      CONTROLLED_QUALIFICATION_SECOND_DRIVER.instanceId,
    );
    expect(childAfter.binding.providerInstanceId).not.toBe(
      CONTROLLED_QUALIFICATION_REVIEW.instanceId,
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

    // A later turn to the child uses the existing child's durable target,
    // despite both mutable selection sources now naming a third instance.
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

    // A later observed child completion uses the production notification path
    // to steer the durable parent target.
    await second.subagents.onObserved(
      {
        instanceId,
        sessionKey: childAfter.sessionKey,
        threadId: childAfter.threadId,
      },
      { archiveDispatched: false, attentions: [], phase: "completed" },
    );
    expect(secondT3.dispatches.at(-1)).toMatchObject({
      command: {
        interactionMode: parentAfter.binding.interactionMode,
        message: {
          text: `Subagent ${childAfter.sessionKey} stopped with phase completed; assigned todo subtree ${childAfter.rootItemId}.`,
        },
        runtimeMode: parentAfter.binding.runtimeMode,
        threadId: parentAfter.threadId,
        type: "thread.turn.start",
      },
      providerContext: providerContextFromBinding(parentAfter.binding),
    });

    const replayedParent = await new WorkflowMcpSessionResolver(
      second.persistence,
    ).resolve(parent.token);
    expect(await waitForRunningThread(client, parentAfter.threadId)).toBe(
      "running",
    );
    const laterChild = await second.subagents.spawn(replayedParent, {
      operationId: "restart-paced-child",
      providerAlias: "secondary",
      rootItemId: "verify",
    });
    if (laterChild.kind !== "spawned") {
      throw new Error("Later child was deferred");
    }
    expect(laterChild.assignment.binding.providerInstanceId).toBe(
      CONTROLLED_QUALIFICATION_SECOND_DRIVER.instanceId,
    );
    expect(laterChild.assignment.binding.runtimeMode).toBe(
      firstChild.assignment.binding.runtimeMode,
    );
    expect(pacedProviders).toEqual([
      CONTROLLED_QUALIFICATION_SECOND_DRIVER.instanceId,
    ]);

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
