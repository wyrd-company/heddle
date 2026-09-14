// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { BoardTask } from "../board-adapter/index.js";
import type { T3DispatchCommand } from "../control-plane/index.js";
import { SqlitePersistence } from "../persistence/index.js";
import type { ProductionConfiguration } from "./configuration.js";
import { EpicProjectCoordinator } from "./epic-projects.js";
import { SyntheticT3 } from "./composition.test-support.js";
import { TaskRepositoryRouter } from "./repository-routing.js";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(
    scratch.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

const task = (status: string): BoardTask => ({
  blocked: false,
  dependencies: [],
  frontMatter: { repos: ["sample-repository"] },
  id: 101,
  priority: "high",
  repos: ["sample-repository"],
  status,
  tags: ["type:epic"],
  title: "Sample delivery",
});

const configuration = (root: string): ProductionConfiguration =>
  ({
    adHocProject: {
      label: "Sample worker",
      workspaceRoot: root,
    },
    session: { baseRef: "main", worktreesRoot: join(root, "worktrees") },
  }) as ProductionConfiguration;

describe("EpicProjectCoordinator", () => {
  it("creates on in-progress and retains the exact project after completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "heddle-epic-project-"));
    scratch.push(root);
    const persistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    const t3 = new SyntheticT3();
    const worktrees: Parameters<
      ConstructorParameters<typeof EpicProjectCoordinator>[5]
    >[0][] = [];
    const config = configuration(root);
    const coordinator = new EpicProjectCoordinator(
      config,
      persistence,
      new TaskRepositoryRouter(root),
      t3,
      () => "2026-01-01T00:00:00.000Z",
      async (input) => void worktrees.push(input),
      undefined,
      () => "generated-epic-project",
    );

    await expect(
      coordinator.reconcile([task("in-progress")]),
    ).resolves.toMatchObject([{ epicId: 101, kind: "created" }]);
    const created = t3.commands[0]!;
    expect(created).toMatchObject({
      projectId: "generated-epic-project",
      title: "Sample delivery - epic-101",
      type: "project.create",
      workspaceRoot: join(root, "worktrees", "101"),
    });
    expect(worktrees).toEqual([
      {
        baseRef: "main",
        branch: "epic/101",
        repositoryName: "sample-repository",
        repositoryRoot: join(root, "tools", "sample-repository"),
        worktreeName: "101",
        worktreesRoot: join(root, "worktrees"),
      },
    ]);
    await expect(coordinator.reconcile([task("uat")])).resolves.toEqual([]);
    await expect(coordinator.reconcile([task("paused")])).resolves.toEqual([]);
    await expect(coordinator.reconcile([task("stopped")])).resolves.toEqual([]);
    expect(t3.commands).toHaveLength(1);

    await expect(coordinator.reconcile([task("done")])).resolves.toEqual([]);
    await expect(coordinator.reconcile([task("done")])).resolves.toEqual([]);
    expect(t3.commands).toHaveLength(1);
    expect(persistence.getEpicProject(101)).toMatchObject({
      projectId: created.projectId,
      repositoryNames: ["sample-repository"],
      state: "active",
    });
    persistence.close();

    const restartedPersistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    const restarted = new EpicProjectCoordinator(
      config,
      restartedPersistence,
      new TaskRepositoryRouter(root),
      t3,
      () => "2027-01-01T00:00:00.000Z",
      async () => undefined,
    );
    await expect(restarted.reconcile([task("done")])).resolves.toEqual([]);
    expect(t3.commands).toHaveLength(1);
    expect(restartedPersistence.getEpicProject(101)).toMatchObject({
      projectId: created.projectId,
      repositoryNames: ["sample-repository"],
      state: "active",
    });
    restartedPersistence.close();
  });

  it("updates an epic title without changing its durable identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "heddle-epic-project-"));
    scratch.push(root);
    const persistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    const t3 = new SyntheticT3();
    const coordinator = new EpicProjectCoordinator(
      configuration(root),
      persistence,
      new TaskRepositoryRouter(root),
      t3,
      undefined,
      async () => undefined,
      undefined,
      () => "generated-epic-project",
    );
    await coordinator.reconcile([task("in-progress")]);
    const create = t3.commands.find(({ type }) => type === "project.create");

    await coordinator.reconcile([
      { ...task("in-progress"), title: "Changed delivery" },
    ]);

    expect(t3.commands.filter(({ type }) => type === "project.create")).toEqual(
      [create],
    );
    expect(
      t3.commands.filter(({ type }) => type === "project.meta.update"),
    ).toEqual([
      expect.objectContaining({
        projectId: "generated-epic-project",
        title: "Changed delivery - epic-101",
      }),
    ]);
    expect(persistence.getEpicProject(101)).toMatchObject({
      projectId: "generated-epic-project",
      projectTitle: "Changed delivery - epic-101",
      projectTitleApplied: true,
      projectTitleRevision: 1,
    });
    persistence.close();
  });

  it("rejects a surviving same-workspace project when Heddle state is fresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "heddle-epic-project-"));
    scratch.push(root);
    const persistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    const t3 = new SyntheticT3();
    await t3.dispatch({
      commandId: "seed-surviving-project",
      createdAt: "2026-01-01T00:00:00.000Z",
      projectId: "surviving-project",
      title: "External work",
      type: "project.create",
      workspaceRoot: join(root, "worktrees", "101"),
    });
    t3.commands.length = 0;
    const worktrees: unknown[] = [];
    const coordinator = new EpicProjectCoordinator(
      configuration(root),
      persistence,
      new TaskRepositoryRouter(root),
      t3,
      undefined,
      async (input) => void worktrees.push(input),
    );

    await expect(coordinator.reconcile([task("in-progress")])).rejects.toThrow(
      "survives at epic workspace root",
    );
    expect(persistence.getEpicProject(101)).toBeUndefined();
    expect(worktrees).toEqual([]);
    expect(t3.commands).toEqual([]);
    persistence.close();
  });

  it("uses one retained active project identity without creating it again", async () => {
    const root = await mkdtemp(join(tmpdir(), "heddle-epic-project-"));
    scratch.push(root);
    const config = configuration(root);
    const persistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    persistence.writeEpicProject({
      createCommandId: "create-retained-project",
      createdAt: "2026-01-01T00:00:00.000Z",
      deleteCommandId: "delete-retained-project",
      epicId: 101,
      projectId: "retained-project",
      projectTitle: "Retained sample",
      projectTitleApplied: true,
      projectTitleRevision: 0,
      repositoryNames: ["sample-repository"],
      state: "active",
    });
    const t3 = new SyntheticT3();
    await t3.dispatch({
      commandId: "seed-retained-project",
      createdAt: "2026-01-01T00:00:00.000Z",
      projectId: "retained-project",
      title: "Retained sample",
      type: "project.create",
      workspaceRoot: join(root, "worktrees", "101"),
    });
    t3.commands.length = 0;
    const coordinator = new EpicProjectCoordinator(
      config,
      persistence,
      new TaskRepositoryRouter(root),
      t3,
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
    expect(t3.commands).toEqual([]);
    persistence.close();
  });

  it("retries one persisted project-create identity after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "heddle-epic-project-"));
    scratch.push(root);
    const config = configuration(root);
    const persistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
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
    const prepareWorktree = async () => undefined;
    const first = new EpicProjectCoordinator(
      config,
      persistence,
      new TaskRepositoryRouter(root),
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
      new TaskRepositoryRouter(root),
      t3,
      () => "2027-01-01T00:00:00.000Z",
      prepareWorktree,
    );
    await expect(
      restarted.reconcile([
        { ...task("in-progress"), title: "Changed sample delivery" },
      ]),
    ).resolves.toMatchObject([{ epicId: 101, kind: "created" }]);
    expect(t3.createAttempts).toBe(1);
    expect(
      t3.commands.filter(({ type }) => type === "project.create"),
    ).toHaveLength(1);
    expect(
      t3.commands.filter(({ type }) => type === "project.meta.update"),
    ).toHaveLength(1);
    expect(persistence.getEpicProject(101)?.state).toBe("active");
    persistence.close();
  });

  it("rejects a repository scope change after the epic project is durable", async () => {
    const root = await mkdtemp(join(tmpdir(), "heddle-epic-project-"));
    scratch.push(root);
    const config = configuration(root);
    const persistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    const routing = new TaskRepositoryRouter(root);
    const coordinator = new EpicProjectCoordinator(
      config,
      persistence,
      routing,
      new SyntheticT3(),
      undefined,
      async () => undefined,
    );
    await coordinator.reconcile([task("in-progress")]);

    await expect(
      coordinator.reconcile([
        {
          ...task("in-progress"),
          repos: ["sample-secondary"],
          frontMatter: { repos: ["sample-secondary"] },
        },
      ]),
    ).rejects.toThrow("Epic 101 changed durable repository scope");
    persistence.close();
  });

  it.each(["active", "creating"] as const)(
    "fails closed when a legacy %s project has no durable repository scope",
    async (state) => {
      const root = await mkdtemp(join(tmpdir(), "heddle-epic-project-"));
      scratch.push(root);
      const persistence = new SqlitePersistence({
        stateDirectory: join(root, "state"),
      });
      persistence.writeEpicProject({
        createCommandId: "create-retained-project",
        createdAt: "2026-01-01T00:00:00.000Z",
        deleteCommandId: "delete-retained-project",
        epicId: 101,
        projectId: "retained-project",
        projectTitle: "Retained sample",
        projectTitleApplied: true,
        projectTitleRevision: 0,
        repositoryNames: ["sample-repository"],
        state,
      });
      const legacyDatabase = new Database(persistence.databasePath);
      legacyDatabase
        .prepare(
          "UPDATE heddle_epic_projects SET repository_names_json = NULL WHERE epic_id = ?",
        )
        .run(101);
      legacyDatabase.close();
      const coordinator = new EpicProjectCoordinator(
        configuration(root),
        persistence,
        new TaskRepositoryRouter(root),
        new SyntheticT3(),
        undefined,
        async () => undefined,
      );

      await expect(
        coordinator.reconcile([task("in-progress")]),
      ).rejects.toThrow(
        "Epic 101 has no durable repository scope; operator recovery is required",
      );
      expect(() =>
        coordinator.projectForTask({ ...task("todo"), id: 102, parent: 101 }),
      ).toThrow(
        "Epic 101 has no durable repository scope; operator recovery is required",
      );
      persistence.close();
    },
  );

  it.each(["deleting", "deleted"] as const)(
    "keeps a legacy %s record fail-closed across process restart",
    async (state) => {
      const root = await mkdtemp(join(tmpdir(), "heddle-epic-project-"));
      scratch.push(root);
      const config = configuration(root);
      const stateDirectory = join(root, "state");
      const t3 = new SyntheticT3();
      const firstPersistence = new SqlitePersistence({ stateDirectory });
      firstPersistence.writeEpicProject({
        createCommandId: "create-retained-project",
        createdAt: "2026-01-01T00:00:00.000Z",
        deleteCommandId: "delete-retained-project",
        epicId: 101,
        projectId: "retained-project",
        projectTitle: "Retained sample",
        projectTitleApplied: true,
        projectTitleRevision: 0,
        repositoryNames: ["sample-repository"],
        state,
      });
      const legacyDatabase = new Database(firstPersistence.databasePath);
      legacyDatabase
        .prepare(
          "UPDATE heddle_epic_projects SET repository_names_json = NULL WHERE epic_id = ?",
        )
        .run(101);
      legacyDatabase.close();
      const first = new EpicProjectCoordinator(
        config,
        firstPersistence,
        new TaskRepositoryRouter(root),
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
        new TaskRepositoryRouter(root),
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
      expect(t3.commands).toHaveLength(0);
      restartedPersistence.close();
    },
  );
});
