// ---
// relationships:
//   verifies: heddle
// ---

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { deliveryBlueprintFixture } from "../engine/lifecycle-blueprint.test-support.js";
import { advanceOperationId } from "../mcp-server/operations.js";
import { createProductionComposition } from "./composition.js";
import {
  execute,
  prepareProductionEpicFixture,
  SyntheticT3,
} from "./composition.test-support.js";

const git = async (cwd: string, ...arguments_: string[]): Promise<string> =>
  (await execute("git", arguments_, { cwd })).stdout.trim();

describe("production concurrent review landing", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => cleanup?.());

  it("activates exact drift remediation after another task moves the epic base", async () => {
    const fixture = await prepareProductionEpicFixture();
    cleanup = fixture.cleanup;
    const repositoryRoot =
      fixture.configuration.products[0]!.repos[0]!.repositoryRoot;
    const templateRoot = fixture.blueprintsRepositoryRoot;
    const standardHash = await git(
      templateRoot,
      "hash-object",
      "handoff-templates/standard.md",
    );
    const remediationHash = await git(
      templateRoot,
      "hash-object",
      "handoff-templates/remediation.md",
    );
    const blueprint = deliveryBlueprintFixture("trivial");
    for (const node of blueprint.nodes) {
      if (node.uses !== "wait") continue;
      node.tools = ["advance"];
      node["todo-template"] = "sample-stage";
      node["handoff-template"] =
        node.handoff === "remediation"
          ? {
              blobHash: remediationHash,
              path: "handoff-templates/remediation.md",
            }
          : {
              blobHash: standardHash,
              path: "handoff-templates/standard.md",
            };
    }
    await writeFile(
      join(fixture.blueprintsRepositoryRoot, "blueprints", "concurrent.json"),
      JSON.stringify({
        $schema: "https://wyrd.company/heddle/lifecycle-blueprint.schema.json",
        ...blueprint,
        relationships: {
          implements: "heddle",
          uses: ["remediation", "sample-stage", "standard"],
        },
      }),
    );
    await git(
      fixture.blueprintsRepositoryRoot,
      "add",
      "blueprints/concurrent.json",
    );
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
        "Add concurrent lifecycle",
      ],
      { cwd: fixture.blueprintsRepositoryRoot },
    );
    await git(fixture.blueprintsRepositoryRoot, "push", "--quiet");
    await execute(
      "kanban-md",
      [
        "--dir",
        fixture.configuration.boardDirectory,
        "edit",
        String(fixture.taskId),
        "--remove-tag",
        "lifecycle:sample",
        "--add-tag",
        "lifecycle:concurrent",
        "--json",
      ],
      { cwd: fixture.root },
    );
    const secondTask = await execute(
      "kanban-md",
      [
        "--dir",
        fixture.configuration.boardDirectory,
        "create",
        "Record another generic change",
        "--status",
        "todo",
        "--parent",
        String(fixture.epicId),
        "--tags",
        "lifecycle:concurrent",
        "--json",
      ],
      { cwd: fixture.root },
    );
    const secondTaskId = (JSON.parse(secondTask.stdout) as { id: number }).id;
    await git(repositoryRoot, "branch", `epic/${fixture.epicId}`, "main");
    const t3 = new SyntheticT3();
    const options = {
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    };
    let composition = createProductionComposition(options);

    await composition.start();
    await composition.scheduler.trigger();
    for (const taskId of [fixture.taskId, secondTaskId]) {
      const worktree = join(
        fixture.configuration.session.worktreesRoot!,
        String(taskId),
        "sample-repository",
      );
      await writeFile(join(worktree, `change-${taskId}.txt`), `${taskId}\n`);
      await git(worktree, "add", `change-${taskId}.txt`);
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
          `Record change ${taskId}`,
        ],
        { cwd: worktree },
      );
      await composition.lifecycle.resume({
        disposition: "complete",
        instanceId: `task-${taskId}`,
        operationId: advanceOperationId(`task-${taskId}:implement:1`),
      });
    }
    await composition.scheduler.trigger();

    const reviewedBaseHead = await git(
      repositoryRoot,
      "rev-parse",
      `epic/${fixture.epicId}`,
    );
    await composition.lifecycle.resume({
      disposition: "approve",
      instanceId: `task-${fixture.taskId}`,
      operationId: advanceOperationId(`task-${fixture.taskId}:review:1`),
    });
    const currentSourceHead = await git(
      repositoryRoot,
      "rev-parse",
      `heddle/task-${secondTaskId}`,
    );
    const drifted = await composition.lifecycle.resume({
      disposition: "approve",
      instanceId: `task-${secondTaskId}`,
      operationId: advanceOperationId(`task-${secondTaskId}:review:1`),
    });
    const currentTargetHead = await git(
      repositoryRoot,
      "rev-parse",
      `epic/${fixture.epicId}`,
    );
    expect(drifted).toMatchObject({
      awaitingNodeIds: ["remediate"],
      status: "awaiting",
    });

    await composition.close();
    composition = createProductionComposition(options);
    await composition.start();
    await expect(composition.scheduler.trigger()).resolves.toBeUndefined();
    await expect(composition.scheduler.trigger()).resolves.toBeUndefined();
    expect(
      composition.persistence
        .listReconcilerRuntime()
        .find(({ taskId }) => taskId === secondTaskId),
    ).toMatchObject({ stageId: "remediate", state: "waiting" });
    expect(
      composition.persistence.getInstance(`task-${fixture.taskId}`)?.state
        .flowcraftContext,
    ).toMatchObject({ status: "completed" });
    expect(composition.attention.list()).toEqual([]);
    const remediationActivation = composition.persistence
      .replayEvents(`task-${secondTaskId}`)
      .find(
        ({ payload, type }) =>
          type === "session:activated" &&
          typeof payload === "object" &&
          payload !== null &&
          !Array.isArray(payload) &&
          payload["stage"] === "remediate",
      );
    expect(remediationActivation).toMatchObject({
      payload: expect.objectContaining({
        stage: "remediate",
      }),
    });
    const renderedDocument = (
      remediationActivation?.payload as { renderedDocument: string }
    ).renderedDocument;
    for (const expected of [
      "review-basis-drift",
      reviewedBaseHead,
      currentSourceHead,
      currentTargetHead,
      "Rebase source branch",
      "without creating a merge commit",
    ]) {
      expect(renderedDocument).toContain(expected);
    }
    await composition.close();
  }, 20_000);

  it("persists and renders remediation when the source is behind at review snapshot", async () => {
    const fixture = await prepareProductionEpicFixture();
    cleanup = fixture.cleanup;
    const repositoryRoot =
      fixture.configuration.products[0]!.repos[0]!.repositoryRoot;
    const templateRoot = fixture.blueprintsRepositoryRoot;
    const standardHash = await git(
      templateRoot,
      "hash-object",
      "handoff-templates/standard.md",
    );
    const remediationHash = await git(
      templateRoot,
      "hash-object",
      "handoff-templates/remediation.md",
    );
    const blueprint = deliveryBlueprintFixture("trivial");
    for (const node of blueprint.nodes) {
      if (node.uses !== "wait") continue;
      node.tools = ["advance"];
      node["todo-template"] = "sample-stage";
      node["handoff-template"] =
        node.handoff === "remediation"
          ? {
              blobHash: remediationHash,
              path: "handoff-templates/remediation.md",
            }
          : {
              blobHash: standardHash,
              path: "handoff-templates/standard.md",
            };
    }
    await writeFile(
      join(fixture.blueprintsRepositoryRoot, "blueprints", "concurrent.json"),
      JSON.stringify({
        $schema: "https://wyrd.company/heddle/lifecycle-blueprint.schema.json",
        ...blueprint,
        relationships: {
          implements: "heddle",
          uses: ["remediation", "sample-stage", "standard"],
        },
      }),
    );
    await git(
      fixture.blueprintsRepositoryRoot,
      "add",
      "blueprints/concurrent.json",
    );
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
        "Add concurrent lifecycle",
      ],
      { cwd: fixture.blueprintsRepositoryRoot },
    );
    await git(fixture.blueprintsRepositoryRoot, "push", "--quiet");
    await execute(
      "kanban-md",
      [
        "--dir",
        fixture.configuration.boardDirectory,
        "edit",
        String(fixture.taskId),
        "--remove-tag",
        "lifecycle:sample",
        "--add-tag",
        "lifecycle:concurrent",
        "--json",
      ],
      { cwd: fixture.root },
    );
    await git(repositoryRoot, "branch", `epic/${fixture.epicId}`, "main");
    const t3 = new SyntheticT3();
    const options = {
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    };
    let composition = createProductionComposition(options);

    await composition.start();
    await composition.scheduler.trigger();
    const worktree = join(
      fixture.configuration.session.worktreesRoot!,
      String(fixture.taskId),
      "sample-repository",
    );
    await writeFile(join(worktree, "change.txt"), "sample\n");
    await git(worktree, "add", "change.txt");
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
        "Record sample change",
      ],
      { cwd: worktree },
    );
    const sourceHead = await git(
      repositoryRoot,
      "rev-parse",
      `heddle/task-${fixture.taskId}`,
    );
    const previousTargetHead = await git(
      repositoryRoot,
      "rev-parse",
      `epic/${fixture.epicId}`,
    );
    const targetTree = await git(
      repositoryRoot,
      "rev-parse",
      `${previousTargetHead}^{tree}`,
    );
    const targetHead = (
      await execute(
        "git",
        [
          "-c",
          "user.name=Fixture User",
          "-c",
          "user.email=fixture@example.invalid",
          "commit-tree",
          targetTree,
          "-p",
          previousTargetHead,
          "-m",
          "Advance sample target",
        ],
        { cwd: repositoryRoot },
      )
    ).stdout.trim();
    await git(
      repositoryRoot,
      "update-ref",
      `refs/heads/epic/${fixture.epicId}`,
      targetHead,
      previousTargetHead,
    );
    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId: `task-${fixture.taskId}`,
      operationId: advanceOperationId(`task-${fixture.taskId}:implement:1`),
    });
    await composition.scheduler.trigger();

    const remediation = await composition.lifecycle.resume({
      disposition: "approve",
      instanceId: `task-${fixture.taskId}`,
      operationId: advanceOperationId(`task-${fixture.taskId}:review:1`),
    });
    expect(remediation).toMatchObject({
      awaitingNodeIds: ["remediate"],
      status: "awaiting",
    });
    expect(
      await git(repositoryRoot, "rev-parse", `epic/${fixture.epicId}`),
    ).toBe(targetHead);

    await composition.close();
    composition = createProductionComposition(options);
    await composition.start();
    await expect(composition.scheduler.trigger()).resolves.toBeUndefined();
    expect(
      composition.persistence
        .listReconcilerRuntime()
        .find(({ taskId }) => taskId === fixture.taskId),
    ).toMatchObject({ stageId: "remediate", state: "waiting" });
    expect(composition.attention.list()).toEqual([]);
    const remediationActivation = composition.persistence
      .replayEvents(`task-${fixture.taskId}`)
      .find(
        ({ payload, type }) =>
          type === "session:activated" &&
          typeof payload === "object" &&
          payload !== null &&
          !Array.isArray(payload) &&
          payload["stage"] === "remediate",
      );
    const renderedDocument = (
      remediationActivation?.payload as { renderedDocument: string }
    ).renderedDocument;
    for (const expected of [
      "review-source-behind",
      "The reviewed source did not contain the target",
      sourceHead,
      targetHead,
      "Rebase source branch",
      "without creating a merge commit",
    ]) {
      expect(renderedDocument).toContain(expected);
    }
    await composition.close();
  }, 20_000);
});
