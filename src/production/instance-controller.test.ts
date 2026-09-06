// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BoardTask } from "../board-adapter/index.js";
import type { LifecycleSnapshot } from "../engine/index.js";
import { SqlitePersistence } from "../persistence/index.js";
import { ProductRoutingCatalog } from "./product-routing.js";
import { DurableAttentionQueue } from "./durable-adapters.js";
import type { EpicProjectCoordinator } from "./epic-projects.js";
import { ProductionInstanceController } from "./instance-controller.js";
import type { ProductionConfiguration } from "./configuration.js";
import { ProductionLifecycleRouter } from "./lifecycle-router.js";

const execute = promisify(execFile);

describe("production instance controller", () => {
  let root = "";

  afterEach(async () => {
    if (root !== "") await rm(root, { force: true, recursive: true });
  });

  it("suppresses intentional lifecycle absence and preserves a genuine missing-instance alarm", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-instance-absence-"));
    const persistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    for (const [taskId, state] of [
      [10, "deferred"],
      [11, "starting"],
      [12, "running"],
    ] as const) {
      persistence.writeReconcilerRuntime({
        boardStatus: state === "deferred" ? "todo" : "in-progress",
        instanceId: `sample-${taskId}`,
        state,
        taskId,
      });
    }
    const attention = new DurableAttentionQueue(persistence);
    const controller = new ProductionInstanceController(
      {} as ProductionConfiguration,
      persistence,
      {} as ProductionLifecycleRouter,
      {} as ProductRoutingCatalog,
      {} as EpicProjectCoordinator,
      attention,
      {} as never,
      "http://127.0.0.1:4774/mcp",
      async () => "",
      { readHandoffTemplate: async () => "", repositoryRoot: root },
    );

    await controller.synchronize([]);

    expect(attention.list()).toEqual([
      expect.objectContaining({
        attentionId: "production:lifecycle-instance-absent:task:12:sample-12",
        taskId: 12,
      }),
    ]);
    expect(
      attention.resolve(
        "production:lifecycle-instance-absent:task:12:sample-12",
      ),
    ).toBe(true);

    await controller.synchronize([]);

    expect(attention.list()).toEqual([
      expect.objectContaining({
        attentionId: "production:lifecycle-instance-absent:task:12:sample-12",
      }),
    ]);

    persistence.createInstance("sample-12", {
      correlationTokens: {},
      flowcraftContext: {
        awaitingNodeIds: [],
        blueprintBlobHash: "0123456789012345678901234567890123456789",
        blueprintPath: "blueprints/sample.json",
        completedOperations: {},
        executionIds: ["sample-execution"],
        nextTransitionNumber: 2,
        pendingAttentions: [],
        pendingTransition: null,
        serializedContext: "{}",
        status: "completed",
      },
      handoffs: [],
      todoState: null,
    });
    await attention.raise({
      attentionId: "production:task-reconciliation-failed:task:12:sample-12",
      code: "task-reconciliation-failed",
      error: {
        cause: null,
        message: "Synthetic unrelated condition",
        name: "Error",
      },
      instanceId: "sample-12",
      kind: "production-error",
      message: "Synthetic unrelated condition",
      taskId: 12,
    });

    await controller.synchronize([
      {
        blocked: false,
        dependencies: [],
        frontMatter: {},
        id: 12,
        priority: "medium",
        status: "in-progress",
        tags: [],
        title: "Arrange inventory",
      },
    ]);

    expect(attention.list()).toEqual([
      expect.objectContaining({
        attentionId: "production:task-reconciliation-failed:task:12:sample-12",
      }),
    ]);
    persistence.close();
  });

  it("does not replay a transition that is active in this service process", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-active-transition-"));
    const persistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    persistence.createInstance("sample-instance", {
      correlationTokens: {},
      flowcraftContext: {
        awaitingNodeIds: ["inspect"],
        blueprintBlobHash: "0123456789012345678901234567890123456789",
        blueprintPath: "blueprints/sample.json",
        completedOperations: {},
        executionIds: ["sample-execution"],
        nextTransitionNumber: 3,
        pendingAttentions: [],
        pendingTransition: {
          disposition: "complete",
          id: "sample-instance:2",
          initialContext: null,
          kind: "resume",
          operationId: "inspect-complete",
          output: {},
          requestFingerprint: "sample-fingerprint",
        },
        serializedContext: "sample-context",
        status: "awaiting",
      },
      handoffs: [],
      todoState: null,
    });
    persistence.writeReconcilerRuntime({
      boardStatus: "in-progress",
      instanceId: "sample-instance",
      state: "waiting",
      taskId: 1,
    });
    const replay = vi.fn<() => Promise<LifecycleSnapshot>>();
    const lifecycle = {
      isTransitionActive: vi.fn(() => true),
      resume: replay,
      start: replay,
    } as unknown as ProductionLifecycleRouter;
    const controller = new ProductionInstanceController(
      {} as ProductionConfiguration,
      persistence,
      lifecycle,
      {} as ProductRoutingCatalog,
      {} as EpicProjectCoordinator,
      { has: async () => false, raise: async () => undefined },
      {} as never,
      "http://127.0.0.1:4774/mcp",
      async () => "",
      { readHandoffTemplate: async () => "", repositoryRoot: root },
    );
    const task: BoardTask = {
      blocked: false,
      dependencies: [],
      frontMatter: {},
      id: 1,
      priority: "medium",
      status: "in-progress",
      tags: [],
      title: "Arrange inventory",
    };

    await controller.synchronize([task]);

    expect(lifecycle.isTransitionActive).toHaveBeenCalledWith(
      "sample-instance",
    );
    expect(replay).not.toHaveBeenCalled();
    expect(persistence.listReconcilerRuntime()).toMatchObject([
      { instanceId: "sample-instance", state: "waiting" },
    ]);
    persistence.close();
  });

  it("starts a non-mechanical lifecycle and raises attention when initial routing cannot select one repository", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-initial-routing-"));
    const persistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    await mkdir(join(root, "blueprints"));
    await writeFile(
      join(root, "blueprints", "non-mechanical.json"),
      JSON.stringify({
        edges: [],
        nodes: [{ id: "finish", uses: "finish" }],
      }),
    );
    await execute("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: root,
    });
    await execute("git", ["add", "blueprints/non-mechanical.json"], {
      cwd: root,
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
        "Add non-mechanical lifecycle fixture",
      ],
      { cwd: root },
    );
    const task: BoardTask = {
      blocked: false,
      dependencies: [],
      frontMatter: {},
      id: 2,
      priority: "medium",
      status: "todo",
      tags: [],
      title: "Arrange inventory",
    };
    const routing = new ProductRoutingCatalog({
      products: [
        {
          name: "Sample product",
          repos: [
            { name: "sample-alpha", repositoryRoot: root },
            { name: "sample-beta", repositoryRoot: root },
          ],
        },
      ],
    } as ProductionConfiguration);
    routing.update([task]);
    const lifecycle = new ProductionLifecycleRouter({
      effects: { finish: async () => ({}) },
      persistence,
      repositoryRoot: root,
      sourceRef: "HEAD",
    });
    const start = vi.spyOn(lifecycle, "start");
    const attention = {
      has: vi.fn(async () => false),
      raise: vi.fn(async () => undefined),
    };
    const controller = new ProductionInstanceController(
      {} as ProductionConfiguration,
      persistence,
      lifecycle,
      routing,
      {} as EpicProjectCoordinator,
      attention,
      {} as never,
      "http://127.0.0.1:4774/mcp",
      async () => "",
      { readHandoffTemplate: async () => "", repositoryRoot: root },
    );

    await controller.start({
      blueprintPath: "blueprints/non-mechanical.json",
      instanceId: "task-2",
      task,
    });

    expect(start).toHaveBeenCalledOnce();
    expect(attention.raise).toHaveBeenCalledWith({
      attentionId: "production:initial-routing-failed:task:2:task-2",
      code: "stage-repository-not-declared",
      instanceId: "task-2",
      kind: "lifecycle-resolution",
      message:
        "Task 2 targets more than one repository but its stage declares none",
      taskId: 2,
    });
    expect(persistence.listReconcilerRuntime()).toMatchObject([
      { instanceId: "task-2", state: "done", taskId: 2 },
    ]);
    persistence.close();
  });
});
