// ---
// relationships:
//   verifies: heddle
// ---

import { afterEach, describe, expect, it, vi } from "vitest";

import { createProductionComposition } from "./composition.js";
import {
  execute,
  prepareProductionEpicFixture,
  SyntheticT3,
  type ProductionFixture,
} from "./composition.test-support.js";
import type { ProductionComposition } from "./composition.js";

describe("production epic acceptance attention resolution", () => {
  let active: ProductionComposition | undefined;
  let fixture: ProductionFixture | undefined;

  afterEach(async () => {
    await active?.close();
    await fixture?.cleanup();
  });

  it("retains missing-child attention across restart and resolves its current entry after correction", async () => {
    const prepared = await prepareProductionEpicFixture();
    fixture = prepared;
    await execute(
      "kanban-md",
      [
        "--dir",
        prepared.configuration.boardDirectory,
        "edit",
        String(prepared.taskId),
        "--status",
        "done",
      ],
      { cwd: prepared.root },
    );
    const t3 = new SyntheticT3();
    const options = {
      blueprintsRepositoryRoot: prepared.blueprintsRepositoryRoot,
      configuration: prepared.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
    };
    const attentionId = `epic:${prepared.epicId}:acceptance:uat-child-missing`;

    active = createProductionComposition(options);
    await active.start();
    expect(active.attention.list()).toContainEqual(
      expect.objectContaining({ attentionId, kind: "epic-acceptance" }),
    );
    expect(await active.attention.has(attentionId)).toBe(true);
    await active.close();
    active = undefined;

    active = createProductionComposition(options);
    await active.start();
    expect(active.attention.list()).toContainEqual(
      expect.objectContaining({ attentionId, kind: "epic-acceptance" }),
    );
    const acceptance = await execute(
      "kanban-md",
      [
        "--dir",
        prepared.configuration.boardDirectory,
        "create",
        "Inspect sample arrangement",
        "--status",
        "backlog",
        "--parent",
        String(prepared.epicId),
        "--tags",
        "uat,lifecycle:sample",
        "--json",
      ],
      { cwd: prepared.root },
    );
    const acceptanceId = (JSON.parse(acceptance.stdout) as { id: number }).id;

    await active.scheduler.trigger();
    await active.scheduler.trigger();

    expect(active.attention.list()).not.toContainEqual(
      expect.objectContaining({ attentionId }),
    );
    expect(await active.attention.has(attentionId)).toBe(true);
    expect(await active.board.readTask(acceptanceId)).toMatchObject({
      frontMatter: { status: "in-progress" },
    });
    expect(active.persistence.listReconcilerRuntime()).toContainEqual(
      expect.objectContaining({ taskId: acceptanceId }),
    );
    expect(
      (await active.board.readBoard()).filter(
        ({ parent }) => parent === prepared.epicId,
      ),
    ).toHaveLength(2);
  });
});
