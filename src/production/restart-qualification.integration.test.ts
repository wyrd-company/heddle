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
  T3ControlPlaneClient,
} from "../control-plane/index.js";
import { prepareProductionFixture } from "./composition.test-support.js";
import { createProductionComposition } from "./composition.js";
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

describe.skipIf(!t3Binary)("restart with an active session", () => {
  it("retains the bound provider when task front matter changes, and replays without duplicating", async () => {
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
        providerBudgets: {
          execution: { usageLimit: 100 },
          secondary: { usageLimit: 100 },
        },
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

    const first = createProductionComposition({
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      workflowMcpEndpoint: `${isolated.baseUrl}/mcp`,
    });
    await first.start();

    const instanceId = `task-${fixture.taskId}`;
    const before = first.persistence.getInstance(instanceId);
    expect(before).toBeDefined();
    const boundRuntime = first.persistence
      .listSessionRuntime()
      .find((entry) => entry.instanceId === instanceId);
    expect(boundRuntime).toBeDefined();
    expect(boundRuntime?.binding.providerInstanceId).toBe(
      QUALIFICATION_EXECUTION.instanceId,
    );
    const boundThreadId = boundRuntime?.threadId;
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

    const second = createProductionComposition({
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      workflowMcpEndpoint: `${isolated.baseUrl}/mcp`,
    });
    teardown.push(() => second.close());
    await second.start();

    const runtimeAfter = second.persistence
      .listSessionRuntime()
      .filter((entry) => entry.instanceId === instanceId);

    // One session occurrence, not a second one created by replay.
    expect(runtimeAfter).toHaveLength(1);
    expect(runtimeAfter[0]?.threadId).toBe(boundThreadId);

    // The existing thread keeps the provider it was bound to, even though the
    // task now names a different alias on a different driver.
    expect(runtimeAfter[0]?.binding.providerInstanceId).toBe(
      QUALIFICATION_EXECUTION.instanceId,
    );
    expect(runtimeAfter[0]?.binding.driverKind).toBe(
      QUALIFICATION_EXECUTION.driver,
    );
    expect(runtimeAfter[0]?.binding.providerInstanceId).not.toBe(
      QUALIFICATION_SECOND_DRIVER.instanceId,
    );
    expect(runtimeAfter[0]?.activation).toBe(boundRuntime?.activation);

    // Replay dispatched no second thread into the control plane.
    expect((await client.getShell()).threads).toHaveLength(threadsBefore);
  }, 300_000);
});
