// ---
// relationships:
//   verifies: heddle
// ---

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { LifecycleBlueprint } from "../engine/index.js";
import { advanceOperationId } from "../mcp-server/operations.js";
import { createProductionComposition } from "./composition.js";
import {
  execute,
  prepareProductionEpicFixture,
  SyntheticT3,
  type ProductionEpicFixture,
} from "./composition.test-support.js";
import type { ProductionComposition } from "./composition.js";

const installUserAcceptanceLifecycle = async (
  fixture: ProductionEpicFixture,
): Promise<void> => {
  const sample = JSON.parse(
    await readFile(
      join(fixture.blueprintsRepositoryRoot, "blueprints/sample.json"),
      "utf8",
    ),
  ) as LifecycleBlueprint;
  const template = sample.nodes.find(({ uses }) => uses === "wait")?.[
    "handoff-template"
  ];
  if (template === undefined) throw new Error("Sample handoff is absent");
  const wait = (id: string) => ({
    "assign-agent-name": "heroes",
    handoff: "standard",
    "handoff-template": template,
    id,
    "provider-alias": "primary",
    "runtime-mode": "full-access",
    tools: ["advance"],
    "todo-template": "sample-stage",
    uses: "wait",
  });
  const blueprint = {
    $schema: "https://wyrd.company/heddle/lifecycle-blueprint.schema.json",
    "board-statuses": {
      finalize: "done",
      "prepare-worktree": "in-progress",
    },
    edges: [
      {
        condition: "result.output.dispositions.ready",
        description: "Continue after every review surface is ready",
        disposition: "ready",
        source: "raise-review-surfaces",
        target: "run-acceptance",
      },
      {
        condition: "result.output.dispositions.accepted",
        description: "Record accepted review dispositions",
        disposition: "accepted",
        source: "run-acceptance",
        target: "record-dispositions",
      },
      {
        condition: "result.output.dispositions.complete",
        description: "Complete the durable acceptance record",
        disposition: "complete",
        source: "record-dispositions",
        target: "closed",
      },
    ],
    nodes: [
      wait("raise-review-surfaces"),
      wait("run-acceptance"),
      wait("record-dispositions"),
      { id: "closed", uses: "complete" },
    ],
    relationships: {
      implements: "heddle",
      uses: ["sample-stage"],
    },
  };
  await writeFile(
    join(fixture.blueprintsRepositoryRoot, "blueprints/user-acceptance.json"),
    `${JSON.stringify(blueprint, null, 2)}\n`,
  );
  await execute("git", ["add", "blueprints/user-acceptance.json"], {
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
      "Add user acceptance lifecycle",
    ],
    { cwd: fixture.blueprintsRepositoryRoot },
  );
  await execute("git", ["push", "--quiet", "origin", "main"], {
    cwd: fixture.blueprintsRepositoryRoot,
  });
};

describe("production user acceptance lifecycle", () => {
  let composition: ProductionComposition | undefined;
  let fixture: ProductionEpicFixture | undefined;

  afterEach(async () => {
    await composition?.close();
    await fixture?.cleanup();
  });

  it("completes the UAT child and accepts its epic from terminal lifecycle evidence", async () => {
    fixture = await prepareProductionEpicFixture();
    await installUserAcceptanceLifecycle(fixture);
    await execute(
      "kanban-md",
      [
        "--dir",
        fixture.configuration.boardDirectory,
        "edit",
        String(fixture.taskId),
        "--status",
        "done",
        "--json",
      ],
      { cwd: fixture.root },
    );
    const created = await execute(
      "kanban-md",
      [
        "--dir",
        fixture.configuration.boardDirectory,
        "create",
        "Inspect sample arrangement",
        "--status",
        "backlog",
        "--parent",
        String(fixture.epicId),
        "--tags",
        "uat,lifecycle:user-acceptance",
        "--json",
      ],
      { cwd: fixture.root },
    );
    const uatId = (JSON.parse(created.stdout) as { id: number }).id;
    const instanceId = `task-${uatId}`;
    composition = createProductionComposition({
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3: new SyntheticT3(),
    });

    await composition.start();
    await composition.scheduler.trigger();
    expect(await composition.board.readTask(fixture.epicId)).toMatchObject({
      frontMatter: { status: "uat" },
    });
    expect(await composition.board.readTask(uatId)).toMatchObject({
      frontMatter: { status: "in-progress" },
    });

    await composition.lifecycle.resume({
      disposition: "ready",
      instanceId,
      operationId: advanceOperationId(`${instanceId}:raise-review-surfaces:1`),
    });
    await composition.scheduler.trigger();
    await composition.lifecycle.resume({
      disposition: "accepted",
      instanceId,
      operationId: advanceOperationId(`${instanceId}:run-acceptance:1`),
    });
    await composition.scheduler.trigger();
    await composition.lifecycle.resume({
      disposition: "complete",
      instanceId,
      operationId: advanceOperationId(`${instanceId}:record-dispositions:1`),
    });
    await composition.scheduler.trigger();
    await composition.scheduler.trigger();

    expect(await composition.board.readTask(uatId)).toMatchObject({
      frontMatter: { status: "done" },
    });
    expect(
      composition.persistence
        .listReconcilerRuntime()
        .filter(({ taskId }) => taskId === uatId),
    ).toEqual([
      expect.objectContaining({
        boardStatus: "done",
        instanceId,
        state: "done",
      }),
    ]);
    expect(await composition.board.readTask(fixture.epicId)).toMatchObject({
      frontMatter: { status: "done" },
    });
  }, 20_000);
});
