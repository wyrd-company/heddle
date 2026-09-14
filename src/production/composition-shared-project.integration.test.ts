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
import { sharedProjectTitle } from "./shared-project.js";

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

  it("generates and persists the shared identity before starting task work", async () => {
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
      title: sharedProjectTitle(fixture.configuration.adHocProject.label),
      type: "project.create",
      workspaceRoot: fixture.configuration.adHocProject.workspaceRoot,
    });
    expect(createCommands[0]?.projectId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(started.persistence.getSharedProject()).toMatchObject({
      createCommandId: createCommands[0]?.commandId,
      projectId: createCommands[0]?.projectId,
      projectTitleApplied: true,
      projectTitleRevision: 0,
      state: "active",
    });
    expect(
      t3.commands.findIndex(({ type }) => type === "project.create"),
    ).toBeLessThan(
      t3.commands.findIndex(({ type }) => type === "thread.create"),
    );
  });

  it("uses the conventional title when no worker label is configured", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    delete fixture.configuration.adHocProject.label;
    const t3 = new SyntheticT3();

    const started = open(fixture, t3);
    await started.start();

    expect(
      t3.commands.find(({ type }) => type === "project.create"),
    ).toMatchObject({ title: "Heddle · ad-hoc work" });
  });

  it("rejects a surviving same-workspace project when Heddle state is fresh", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const t3 = new SyntheticT3();
    await t3.dispatch({
      commandId: "existing-project-create",
      createdAt: "2026-01-01T00:00:00.000Z",
      projectId: "surviving-project",
      title: "External work",
      type: "project.create",
      workspaceRoot: fixture.configuration.adHocProject.workspaceRoot,
    });
    t3.commands.length = 0;

    const started = open(fixture, t3);
    await expect(started.start()).rejects.toThrow(
      "Shared project (unprovisioned) reconciliation failed: T3 project 'surviving-project' survives at workspace root",
    );
    expect(started.persistence.getSharedProject()).toBeUndefined();
    expect(t3.commands).toHaveLength(0);
  });

  it("accepts the control plane's normalized form of the durable workspace root", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const configuredRoot = `${fixture.configuration.adHocProject.workspaceRoot}/`;
    fixture.configuration.adHocProject.workspaceRoot = configuredRoot;
    const t3 = new SyntheticT3();
    const started = open(fixture, t3);
    started.persistence.writeSharedProject({
      createCommandId: "existing-normalized-project-create",
      createdAt: "2026-01-01T00:00:00.000Z",
      projectId: "retained-project",
      projectTitle: "Retained work",
      projectTitleApplied: true,
      projectTitleRevision: 0,
      state: "active",
      workspaceRoot: configuredRoot,
    });
    await t3.dispatch({
      commandId: "seed-retained-project",
      createdAt: "2026-01-01T00:00:00.000Z",
      projectId: "retained-project",
      title: sharedProjectTitle(fixture.configuration.adHocProject.label),
      type: "project.create",
      workspaceRoot: configuredRoot.slice(0, -1),
    });
    t3.commands.length = 0;

    await started.start();

    expect(
      t3.commands.filter(({ type }) => type === "project.create"),
    ).toHaveLength(0);
    expect(started.persistence.getSharedProject()).toMatchObject({
      projectId: "retained-project",
      state: "active",
      workspaceRoot: configuredRoot,
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
      "reconciliation failed: ambiguous create",
    );
    expect(first.persistence.getSharedProject()?.state).toBe("creating");
    const retainedId = first.persistence.getSharedProject()?.projectId;
    await first.close();
    composition = undefined;

    const restarted = open(fixture, t3);
    await restarted.start();

    expect(t3.createAttempts).toBe(1);
    expect(
      t3.commands.filter(({ type }) => type === "project.create"),
    ).toHaveLength(1);
    expect(restarted.persistence.getSharedProject()).toMatchObject({
      projectId: retainedId,
      state: "active",
    });
  });

  it("recreates an active durable project with the exact identity", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const firstT3 = new SyntheticT3();
    const first = open(fixture, firstT3);
    await first.start();
    const originalCreate = firstT3.commands.find(
      ({ type }) => type === "project.create",
    );
    await first.close();
    composition = undefined;

    const replacementT3 = new SyntheticT3();
    const restarted = open(fixture, replacementT3);
    await restarted.start();

    expect(
      replacementT3.commands.filter(({ type }) => type === "project.create"),
    ).toEqual([originalCreate]);
    expect(restarted.persistence.getSharedProject()).toMatchObject({
      createCommandId: originalCreate?.commandId,
      projectId: originalCreate?.projectId,
      state: "active",
    });
  });

  it("fails startup closed before recording identity when T3 is unavailable", async () => {
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
      "Shared project (unprovisioned) reconciliation failed: control plane unavailable",
    );
    expect(started.persistence.getSharedProject()).toBeUndefined();
    expect(started.persistence.listReconcilerRuntime()).toHaveLength(0);
    expect(t3.commands).toHaveLength(0);
  });

  it("updates the optional label without changing the durable identity", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const t3 = new SyntheticT3();
    const first = open(fixture, t3);
    await first.start();
    const original = first.persistence.getSharedProject();
    await first.close();
    composition = undefined;
    fixture.configuration.adHocProject.label = "Changed worker";

    const restarted = open(fixture, t3);
    await restarted.start();

    expect(
      t3.commands.filter(({ type }) => type === "project.create"),
    ).toHaveLength(1);
    expect(
      t3.commands.filter(({ type }) => type === "project.meta.update"),
    ).toEqual([
      expect.objectContaining({
        projectId: original?.projectId,
        title: sharedProjectTitle("Changed worker"),
      }),
    ]);
    expect(restarted.persistence.getSharedProject()).toMatchObject({
      projectId: original?.projectId,
      projectTitle: sharedProjectTitle("Changed worker"),
      projectTitleApplied: true,
      projectTitleRevision: 1,
    });
  });

  it("completes an ambiguously applied title revision without dispatching it twice", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    class AmbiguousTitleT3 extends SyntheticT3 {
      titleAttempts = 0;

      override async dispatch(command: T3DispatchCommand) {
        const result = await super.dispatch(command);
        if (command.type === "project.meta.update") {
          this.titleAttempts += 1;
          if (this.titleAttempts === 1) throw new Error("ambiguous title");
        }
        return result;
      }
    }
    const t3 = new AmbiguousTitleT3();
    const first = open(fixture, t3);
    await first.start();
    const retainedId = first.persistence.getSharedProject()?.projectId;
    await first.close();
    composition = undefined;
    fixture.configuration.adHocProject.label = "Changed worker";

    const changing = open(fixture, t3);
    await expect(changing.start()).rejects.toThrow("ambiguous title");
    expect(changing.persistence.getSharedProject()).toMatchObject({
      projectId: retainedId,
      projectTitleApplied: false,
      projectTitleRevision: 1,
    });
    await changing.close();
    composition = undefined;

    const restarted = open(fixture, t3);
    await restarted.start();

    expect(t3.titleAttempts).toBe(1);
    expect(restarted.persistence.getSharedProject()).toMatchObject({
      projectId: retainedId,
      projectTitleApplied: true,
      projectTitleRevision: 1,
    });
  });

  it("fails closed when configuration changes the durable workspace root", async () => {
    const fixture = await prepareProductionFixture();
    cleanup = fixture.cleanup;
    const t3 = new SyntheticT3();
    const first = open(fixture, t3);
    await first.start();
    const original = first.persistence.getSharedProject();
    await first.close();
    composition = undefined;
    fixture.configuration.adHocProject.workspaceRoot += "-other";

    const restarted = open(fixture, t3);
    await expect(restarted.start()).rejects.toThrow(
      `Shared project (${original?.projectId}) reconciliation failed: the durable workspace root differs from configuration`,
    );
    expect(restarted.persistence.getSharedProject()).toMatchObject({
      projectId: original?.projectId,
      workspaceRoot: original?.workspaceRoot,
    });
  });
});
