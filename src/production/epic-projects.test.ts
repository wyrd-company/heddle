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
    session: { worktreesRoot: join(root, "worktrees") },
  }) as ProductionConfiguration;

describe("EpicProjectCoordinator", () => {
  it("creates on in-progress, retains through UAT, and deletes only on done", async () => {
    const root = await mkdtemp(join(tmpdir(), "heddle-epic-project-"));
    scratch.push(root);
    const persistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    const commands: T3DispatchCommand[] = [];
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
    await expect(coordinator.reconcile([task("uat")])).resolves.toEqual([]);
    await expect(coordinator.reconcile([task("paused")])).resolves.toEqual([]);
    await expect(coordinator.reconcile([task("stopped")])).resolves.toEqual([]);
    expect(commands).toHaveLength(1);

    await expect(coordinator.reconcile([task("done")])).resolves.toMatchObject([
      { epicId: 101, kind: "deleted", projectId: created.projectId },
    ]);
    expect(commands[1]).toMatchObject({
      force: true,
      projectId: created.projectId,
      type: "project.delete",
    });
    expect(persistence.getEpicProject(101)).toBeUndefined();
    persistence.close();
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
    );

    await expect(coordinator.reconcile([task("uat")])).resolves.toEqual([]);
    expect(
      coordinator.projectForTask({ ...task("todo"), id: 102, parent: 101 }),
    ).toBe("retained-project");
    expect(commands).toEqual([]);
    persistence.close();
  });
});
