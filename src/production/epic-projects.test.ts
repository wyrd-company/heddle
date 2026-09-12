// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BoardTask } from "../board-adapter/index.js";
import type { T3DispatchCommand } from "../control-plane/index.js";
import { SqlitePersistence } from "../persistence/index.js";
import type { ProductionConfiguration } from "./configuration.js";
import { EpicProjectCoordinator } from "./epic-projects.js";
import { ProductRoutingCatalog } from "./product-routing.js";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(
    scratch.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

const task = (status: string): BoardTask => ({
  blocked: false,
  dependencies: [],
  id: 101,
  priority: "high",
  product: "Sample product",
  repos: ["sample-repository"],
  status,
  tags: ["type:epic"],
  title: "Sample delivery",
});

const configuration = (root: string): ProductionConfiguration =>
  ({
    adHocProject: {
      name: "Shared tasks",
      projectId: "shared-project",
      workspaceRoot: root,
    },
    products: [
      {
        name: "Sample product",
        repos: [
          {
            name: "sample-repository",
            repositoryRoot: join(root, "sample-repository"),
          },
        ],
      },
    ],
    session: { baseRef: "main", worktreesRoot: join(root, "worktrees") },
  }) as ProductionConfiguration;

describe("EpicProjectCoordinator", () => {
  it("creates on in-progress and retains the exact project after completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "heddle-epic-project-"));
    scratch.push(root);
    const persistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    const commands: T3DispatchCommand[] = [];
    const worktrees: Parameters<
      ConstructorParameters<typeof EpicProjectCoordinator>[5]
    >[0][] = [];
    const config = configuration(root);
    const coordinator = new EpicProjectCoordinator(
      config,
      persistence,
      new ProductRoutingCatalog(config),
      {
        dispatch: async (command) => (
          commands.push(command),
          { sequence: commands.length }
        ),
      },
      () => "2026-01-01T00:00:00.000Z",
      async (input) => void worktrees.push(input),
    );

    await expect(
      coordinator.reconcile([task("in-progress")]),
    ).resolves.toMatchObject([{ epicId: 101, kind: "created" }]);
    const created = commands[0]!;
    expect(created).toMatchObject({
      title: "Sample product - epic-101",
      type: "project.create",
      workspaceRoot: join(root, "worktrees", "101"),
    });
    expect(worktrees).toEqual([
      {
        baseRef: "main",
        branch: "epic/101",
        repositoryName: "sample-repository",
        repositoryRoot: join(root, "sample-repository"),
        worktreeName: "101",
        worktreesRoot: join(root, "worktrees"),
      },
    ]);
    await expect(coordinator.reconcile([task("uat")])).resolves.toEqual([]);
    await expect(coordinator.reconcile([task("paused")])).resolves.toEqual([]);
    await expect(coordinator.reconcile([task("stopped")])).resolves.toEqual([]);
    expect(commands).toHaveLength(1);

    await expect(coordinator.reconcile([task("done")])).resolves.toEqual([]);
    await expect(coordinator.reconcile([task("done")])).resolves.toEqual([]);
    expect(commands).toHaveLength(1);
    expect(persistence.getEpicProject(101)).toMatchObject({
      projectId: created.projectId,
      state: "active",
    });
    persistence.close();

    const restartedPersistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    const restarted = new EpicProjectCoordinator(
      config,
      restartedPersistence,
      new ProductRoutingCatalog(config),
      {
        dispatch: async (command) => (
          commands.push(command),
          { sequence: commands.length }
        ),
      },
      () => "2027-01-01T00:00:00.000Z",
      async () => undefined,
    );
    await expect(restarted.reconcile([task("done")])).resolves.toEqual([]);
    expect(commands).toHaveLength(1);
    expect(restartedPersistence.getEpicProject(101)).toMatchObject({
      projectId: created.projectId,
      state: "active",
    });
    restartedPersistence.close();
  });

  it("retains configured epic project identity without creating it again", async () => {
    const root = await mkdtemp(join(tmpdir(), "heddle-epic-project-"));
    scratch.push(root);
    const config = configuration(root);
    config.products[0]!.epicProject = {
      epicId: 101,
      projectId: "retained-project",
    };
    const persistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    const commands: T3DispatchCommand[] = [];
    const coordinator = new EpicProjectCoordinator(
      config,
      persistence,
      new ProductRoutingCatalog(config),
      {
        dispatch: async (command) => (
          commands.push(command),
          { sequence: commands.length }
        ),
      },
      undefined,
      async () => undefined,
    );

    await expect(coordinator.reconcile([task("uat")])).resolves.toEqual([]);
    expect(
      coordinator.projectForTask({ ...task("todo"), id: 102, parent: 101 }),
    ).toBe("retained-project");
    expect(
      coordinator.baseBranchForTask({ ...task("todo"), id: 102, parent: 101 }),
    ).toBe("epic/101");
    expect(() =>
      coordinator.baseBranchForTask({ ...task("todo"), id: 103, parent: 999 }),
    ).toThrow("Epic 999 has no active T3 project for task 103");
    expect(commands).toEqual([]);
    persistence.close();
  });

  it("retries one persisted project-create identity after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "heddle-epic-project-"));
    scratch.push(root);
    const config = configuration(root);
    const persistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    const commands: T3DispatchCommand[] = [];
    const t3 = {
      dispatch: async (command: T3DispatchCommand) => {
        commands.push(command);
        if (commands.length === 1) throw new Error("ambiguous create");
        return { sequence: commands.length };
      },
    };
    const prepareWorktree = async () => undefined;
    const first = new EpicProjectCoordinator(
      config,
      persistence,
      new ProductRoutingCatalog(config),
      t3,
      () => "2026-01-01T00:00:00.000Z",
      prepareWorktree,
    );

    await expect(first.reconcile([task("in-progress")])).rejects.toThrow(
      "ambiguous create",
    );
    expect(persistence.getEpicProject(101)?.state).toBe("creating");

    const restarted = new EpicProjectCoordinator(
      config,
      persistence,
      new ProductRoutingCatalog(config),
      t3,
      () => "2027-01-01T00:00:00.000Z",
      prepareWorktree,
    );
    await expect(
      restarted.reconcile([task("in-progress")]),
    ).resolves.toMatchObject([{ epicId: 101, kind: "created" }]);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(persistence.getEpicProject(101)?.state).toBe("active");
    persistence.close();
  });

  it("rejects a product change after the epic project is durable", async () => {
    const root = await mkdtemp(join(tmpdir(), "heddle-epic-project-"));
    scratch.push(root);
    const config = configuration(root);
    config.products.push({
      name: "Second product",
      repos: [
        {
          name: "sample-secondary",
          repositoryRoot: join(root, "sample-secondary"),
        },
      ],
    });
    const persistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    const routing = new ProductRoutingCatalog(config);
    const coordinator = new EpicProjectCoordinator(
      config,
      persistence,
      routing,
      { dispatch: async () => ({ sequence: 1 }) },
      undefined,
      async () => undefined,
    );
    await coordinator.reconcile([task("in-progress")]);

    await expect(
      coordinator.reconcile([
        {
          ...task("in-progress"),
          product: "Second product",
          repos: ["sample-secondary"],
        },
      ]),
    ).rejects.toThrow("Epic 101 changed durable product identity");
    persistence.close();
  });

  it.each(["deleting", "deleted"] as const)(
    "keeps a legacy %s record fail-closed across process restart",
    async (state) => {
      const root = await mkdtemp(join(tmpdir(), "heddle-epic-project-"));
      scratch.push(root);
      const config = configuration(root);
      config.products[0]!.epicProject = {
        epicId: 101,
        projectId: "retained-project",
      };
      const stateDirectory = join(root, "state");
      const commands: T3DispatchCommand[] = [];
      const t3 = {
        dispatch: async (command: T3DispatchCommand) => (
          commands.push(command),
          { sequence: commands.length }
        ),
      };
      const firstPersistence = new SqlitePersistence({ stateDirectory });
      firstPersistence.writeEpicProject({
        createCommandId: "create-retained-project",
        createdAt: "2026-01-01T00:00:00.000Z",
        deleteCommandId: "delete-retained-project",
        epicId: 101,
        productName: "Sample product",
        projectId: "retained-project",
        state,
      });
      const first = new EpicProjectCoordinator(
        config,
        firstPersistence,
        new ProductRoutingCatalog(config),
        t3,
        undefined,
        async () => undefined,
      );

      await expect(first.reconcile([task("done")])).resolves.toEqual([]);
      expect(firstPersistence.getEpicProject(101)?.state).toBe(state);
      firstPersistence.close();

      const restartedPersistence = new SqlitePersistence({ stateDirectory });
      const restarted = new EpicProjectCoordinator(
        config,
        restartedPersistence,
        new ProductRoutingCatalog(config),
        t3,
        undefined,
        async () => undefined,
      );
      await expect(restarted.reconcile([task("done")])).resolves.toEqual([]);
      await expect(restarted.reconcile([task("in-progress")])).rejects.toThrow(
        "project deletion cannot be reversed",
      );
      expect(restartedPersistence.getEpicProject(101)?.state).toBe(state);
      expect(() =>
        restarted.projectForTask({ ...task("todo"), id: 102, parent: 101 }),
      ).toThrow("has no active T3 project");
      expect(commands).toHaveLength(0);
      restartedPersistence.close();
    },
  );
});
