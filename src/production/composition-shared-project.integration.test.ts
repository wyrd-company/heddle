// ---
// relationships:
//   verifies: heddle
// ---

import { afterEach, describe, expect, it, vi } from "vitest";

import type { T3DispatchCommand } from "../control-plane/index.js";
import {
  createProductionComposition,
  type ProductionComposition,
} from "./composition.js";
import {
  prepareProductionFixture,
  SyntheticT3,
} from "./composition.test-support.js";

describe("production shared-project reconciliation", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let composition: ProductionComposition | undefined;

  afterEach(async () => {
    await composition?.close().catch(() => undefined);
    await cleanup?.();
  });

  const open = (
    fixture: Awaited<ReturnType<typeof prepareProductionFixture>>,
    t3: SyntheticT3,
  ): ProductionComposition => {
    const created = createProductionComposition({
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
    });
    composition = created;
    return created;
  };

  it("creates the absent configured shared project before starting task work", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const t3 = new SyntheticT3();

    const started = open(fixture, t3);
    await started.start();

    const createCommands = t3.commands.filter(
      ({ type }) => type === "project.create",
    );
    expect(createCommands).toHaveLength(1);
    expect(createCommands[0]).toMatchObject({
      projectId: fixture.configuration.adHocProject.projectId,
      title: fixture.configuration.adHocProject.name,
      type: "project.create",
      workspaceRoot: fixture.configuration.adHocProject.workspaceRoot,
    });
    expect(createCommands[0]?.commandId).toBe(
      "b409219c-5f1b-4cae-a7f1-aafa1643e100",
    );
    expect(started.persistence.getSharedProject()).toMatchObject({
      createCommandId: createCommands[0]?.commandId,
      projectId: fixture.configuration.adHocProject.projectId,
      state: "active",
    });
    expect(
      t3.commands.findIndex(({ type }) => type === "project.create"),
    ).toBeLessThan(
      t3.commands.findIndex(({ type }) => type === "thread.create"),
    );
  });

  it("records an already-present configured shared project without creating it", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const t3 = new SyntheticT3();
    await t3.dispatch({
      commandId: "existing-project-create",
      createdAt: "2026-01-01T00:00:00.000Z",
      projectId: fixture.configuration.adHocProject.projectId,
      title: fixture.configuration.adHocProject.name,
      type: "project.create",
      workspaceRoot: fixture.configuration.adHocProject.workspaceRoot,
    });
    t3.commands.length = 0;
    t3.dispatches.length = 0;

    const started = open(fixture, t3);
    await started.start();

    expect(
      t3.commands.filter(({ type }) => type === "project.create"),
    ).toHaveLength(0);
    expect(started.persistence.getSharedProject()).toMatchObject({
      createdAt: "2026-01-01T00:00:00.000Z",
      projectId: fixture.configuration.adHocProject.projectId,
      state: "active",
    });
  });

  it("does not dispatch a second creation after an ambiguous successful effect", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    class AmbiguousCreateT3 extends SyntheticT3 {
      createAttempts = 0;

      override async dispatch(command: T3DispatchCommand) {
        const result = await super.dispatch(command);
        if (command.type === "project.create") {
          this.createAttempts += 1;
          if (this.createAttempts === 1) throw new Error("ambiguous create");
        }
        return result;
      }
    }
    const t3 = new AmbiguousCreateT3();

    const first = open(fixture, t3);
    await expect(first.start()).rejects.toThrow(
      "Shared project 'Shared tasks' (workspace-project) reconciliation failed: ambiguous create",
    );
    expect(first.persistence.getSharedProject()?.state).toBe("creating");
    await first.close();
    composition = undefined;

    const restarted = open(fixture, t3);
    await restarted.start();

    expect(t3.createAttempts).toBe(1);
    expect(
      t3.commands.filter(({ type }) => type === "project.create"),
    ).toHaveLength(1);
    expect(restarted.persistence.getSharedProject()?.state).toBe("active");
  });

  it("fails startup closed and names the shared project when reconciliation fails", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    class UnavailableT3 extends SyntheticT3 {
      override async getShell(): ReturnType<SyntheticT3["getShell"]> {
        throw new Error("control plane unavailable");
      }
    }
    const t3 = new UnavailableT3();

    const started = open(fixture, t3);
    await expect(started.start()).rejects.toThrow(
      "Shared project 'Shared tasks' (workspace-project) reconciliation failed: control plane unavailable",
    );
    expect(started.persistence.listReconcilerRuntime()).toHaveLength(0);
    expect(t3.commands).toHaveLength(0);
  });

  it("fails closed when the existing control-plane project has different metadata", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const t3 = new SyntheticT3();
    await t3.dispatch({
      commandId: "different-project-create",
      createdAt: "2026-01-01T00:00:00.000Z",
      projectId: fixture.configuration.adHocProject.projectId,
      title: "Different shared records",
      type: "project.create",
      workspaceRoot: fixture.configuration.adHocProject.workspaceRoot,
    });
    t3.commands.length = 0;

    const started = open(fixture, t3);
    await expect(started.start()).rejects.toThrow(
      "Shared project 'Shared tasks' (workspace-project) reconciliation failed: the control-plane identity differs from configuration",
    );
    expect(started.persistence.getSharedProject()).toBeUndefined();
    expect(t3.commands).toHaveLength(0);
  });

  it("fails closed when configuration changes the durable shared-project identity", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const t3 = new SyntheticT3();
    const first = open(fixture, t3);
    await first.start();
    await first.close();
    composition = undefined;
    const commandCount = t3.commands.length;
    fixture.configuration.adHocProject.name = "Changed shared records";

    const restarted = open(fixture, t3);
    await expect(restarted.start()).rejects.toThrow(
      "Shared project 'Changed shared records' (workspace-project) reconciliation failed: the durable identity differs from configuration",
    );
    expect(t3.commands).toHaveLength(commandCount);
  });
});
