// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BoardTask } from "../board-adapter/index.js";
import type { LifecycleSnapshot } from "../engine/index.js";
import { SqlitePersistence } from "../persistence/index.js";
import type { ProductRoutingCatalog } from "./product-routing.js";
import type { EpicProjectCoordinator } from "./epic-projects.js";
import { ProductionInstanceController } from "./instance-controller.js";
import type { ProductionConfiguration } from "./configuration.js";
import type { ProductionLifecycleRouter } from "./lifecycle-router.js";

describe("production instance controller", () => {
  let root = "";

  afterEach(async () => {
    if (root !== "") await rm(root, { force: true, recursive: true });
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
});
