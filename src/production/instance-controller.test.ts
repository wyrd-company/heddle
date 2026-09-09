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
import type {
  LifecycleBlueprint,
  LifecycleEffect,
  LifecycleSnapshot,
} from "../engine/index.js";
import { SqlitePersistence } from "../persistence/index.js";
import { resolvedSessionBindingFixture } from "../persistence/resolved-session-binding.test-support.js";
import { ProductRoutingCatalog } from "./product-routing.js";
import { DurableAttentionQueue } from "./durable-adapters.js";
import type { EpicProjectCoordinator } from "./epic-projects.js";
import {
  incidentAdmissionPolicy,
  ProductionIncidentCoordinator,
} from "./incident-coordinator.js";
import { productionErrorIncidentId } from "./error-visibility.js";
import { ProductionInstanceController } from "./instance-controller.js";
import type { ProductionConfiguration } from "./configuration.js";
import { ProductionLifecycleRouter } from "./lifecycle-router.js";

const execute = promisify(execFile);

describe("production instance controller", () => {
  let root = "";

  afterEach(async () => {
    if (root !== "") await rm(root, { force: true, recursive: true });
  });

  it("rejects escalation reactivation for a different awaiting stage", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-escalation-stage-"));
    const persistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    persistence.createInstance("sample-10", {
      correlationTokens: {},
      flowcraftContext: {
        awaitingNodeIds: ["arrange"],
        blueprintBlobHash: "0123456789012345678901234567890123456789",
        blueprintPath: "blueprints/sample.json",
        completedOperations: {},
        executionIds: ["sample-execution"],
        nextTransitionNumber: 2,
        pendingAttentions: [],
        pendingTransition: null,
        serializedContext: "{}",
        status: "awaiting",
      },
      handoffs: [],
      todoState: null,
    });
    const controller = new ProductionInstanceController(
      {} as ProductionConfiguration,
      persistence,
      {} as ProductionLifecycleRouter,
      {} as ProductRoutingCatalog,
      {} as EpicProjectCoordinator,
      new DurableAttentionQueue(persistence),
      {} as never,
      "http://127.0.0.1:4774/mcp",
      async () => "",
      { readHandoffTemplate: async () => "", repositoryRoot: root },
    );

    await expect(
      controller.reactivateStageForEscalation({
        instanceId: "sample-10",
        stageId: "verify",
        task: {
          blocked: false,
          dependencies: [],
          frontMatter: {},
          id: 10,
          priority: "medium",
          status: "in-progress",
          tags: [],
          title: "Arrange inventory",
        },
      }),
    ).rejects.toThrow(
      "Escalation delivery no longer matches the awaiting stage",
    );
    persistence.close();
  });

  it("fails closed when an overlapping fallback list would collide with another role", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-provider-collision-"));
    const persistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    const task: BoardTask = {
      blocked: false,
      dependencies: [],
      frontMatter: {},
      id: 11,
      priority: "medium",
      status: "in-progress",
      tags: [],
      title: "Arrange inventory",
    };
    persistence.writeSessionRuntime({
      activation: 1,
      binding: resolvedSessionBindingFixture({
        alias: "primary",
        modelSlug: "model-two",
        providerDisplayName: "Workbench Beta",
        providerInstanceId: "provider-two",
        sessionKey: "sample-11:implement:1",
        threadId: "thread-primary",
      }),
      instanceId: "sample-11",
      sessionKey: "sample-11:implement:1",
      stageId: "implement",
      threadId: "thread-primary",
    });
    persistence.writeReconcilerRuntime({
      boardStatus: "in-progress",
      instanceId: "sample-11",
      provider: "provider-one",
      sessionKey: "sample-11:review:1",
      stageId: "review",
      state: "waiting",
      taskId: task.id,
      threadId: "thread-reviewer",
    });
    persistence.writeSessionRuntime({
      activation: 1,
      binding: resolvedSessionBindingFixture({
        alias: "reviewer",
        modelSlug: "model-one",
        providerDisplayName: "Workbench Alpha",
        providerInstanceId: "provider-one",
        sessionKey: "sample-11:review:1",
        threadId: "thread-reviewer",
      }),
      bindingState: "provisional",
      instanceId: "sample-11",
      sessionKey: "sample-11:review:1",
      stageId: "review",
      threadId: "thread-reviewer",
    });
    const attention = new DurableAttentionQueue(persistence);
    const selections = [
      {
        alias: "reviewer",
        driverKind: "sample-driver",
        interactionMode: "default",
        model: { isCustom: false, name: "Model One", slug: "model-one" },
        observedCliVersion: "1.0.0",
        providerDisplayName: "Workbench Alpha",
        providerInstanceId: "provider-one",
        runtimeMode: "auto" as const,
      },
      {
        alias: "reviewer",
        driverKind: "sample-driver",
        interactionMode: "default",
        model: { isCustom: false, name: "Model Two", slug: "model-two" },
        observedCliVersion: "1.0.0",
        providerDisplayName: "Workbench Beta",
        providerInstanceId: "provider-two",
        runtimeMode: "auto" as const,
      },
    ];
    const controller = new ProductionInstanceController(
      {
        pushover: {
          applicationToken: "sample-application-token",
          userKey: "sample-user-key",
        },
        session: {
          baseRef: "main",
          defaultProviderAlias: "reviewer",
          defaultRuntimeMode: "auto",
          defaultSelection: selections[0],
          interactionMode: "default",
          resolvedSelections: selections,
          skillPointer: "skill://sample",
        },
        t3: { accessToken: "sample-access-token" },
      } as never,
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

    await expect(
      controller.recoverProviderStartFailure(
        task,
        {
          instanceId: "sample-11",
          sessionKey: "sample-11:review:1",
          threadId: "thread-reviewer",
        },
        {
          id: "thread-reviewer",
          latestTurn: { startedAt: null, state: "error" },
          session: {
            lastError:
              "Sample start failed with sample-access-token at https://actor:password@host.invalid/path",
            status: "error",
          },
        },
      ),
    ).resolves.toBe(true);
    await expect(
      controller.recoverProviderStartFailure(
        task,
        {
          instanceId: "sample-11",
          sessionKey: "sample-11:review:1",
          threadId: "thread-reviewer",
        },
        {
          id: "thread-reviewer",
          latestTurn: { startedAt: null, state: "error" },
          session: {
            lastError: "Sample start failed",
            status: "error",
          },
        },
      ),
    ).resolves.toBe(true);

    const binding = persistence
      .listSessionRuntime()
      .find(({ sessionKey }) => sessionKey === "sample-11:review:1")!.binding;
    expect(binding.skippedCandidates).toHaveLength(2);
    expect(JSON.stringify(binding.skippedCandidates)).not.toContain(
      "sample-access-token",
    );
    expect(JSON.stringify(binding.skippedCandidates)).not.toContain(
      "actor:password",
    );
    expect(JSON.stringify(binding.skippedCandidates)).toContain("[redacted]");
    expect(binding.skippedCandidates[1]?.failure.message).toContain(
      "started alias 'primary' already holds it",
    );
    expect(persistence.listAttention()).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          code: "provider-alias-exhausted",
          message: expect.stringContaining("started alias 'primary'"),
        }),
      }),
    );
    persistence.close();
  });

  it("locks a provisional binding instead of falling back after a turn starts", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-provider-started-"));
    const persistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    const binding = resolvedSessionBindingFixture({
      sessionKey: "sample-11:implement:1",
      threadId: "thread-primary",
    });
    persistence.writeSessionRuntime({
      activation: 1,
      binding,
      bindingState: "provisional",
      instanceId: "sample-11",
      sessionKey: binding.sessionKey,
      stageId: "implement",
      threadId: binding.threadId,
    });
    const controller = new ProductionInstanceController(
      {} as never,
      persistence,
      {} as ProductionLifecycleRouter,
      {} as ProductRoutingCatalog,
      {} as EpicProjectCoordinator,
      new DurableAttentionQueue(persistence),
      {} as never,
      "http://127.0.0.1:4774/mcp",
      async () => "",
      { readHandoffTemplate: async () => "", repositoryRoot: root },
    );

    await expect(
      controller.recoverProviderStartFailure(
        { id: 11 } as BoardTask,
        {
          instanceId: "sample-11",
          sessionKey: binding.sessionKey,
          threadId: binding.threadId,
        },
        {
          id: binding.threadId,
          latestTurn: {
            startedAt: "2026-01-01T00:00:00.000Z",
            state: "error",
          },
          session: { lastError: "Turn failed", status: "error" },
        },
      ),
    ).resolves.toBe(false);
    expect(persistence.listSessionRuntime()[0]).not.toHaveProperty(
      "bindingState",
    );
    expect(persistence.listAttention()).toEqual([]);
    persistence.close();
  });

  it("suppresses deferred lifecycle absence and preserves a genuine missing-instance alarm", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-instance-absence-"));
    const persistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    for (const [taskId, state] of [
      [10, "deferred"],
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

  it("retries a retained start through the default incident retry policy", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-incomplete-start-"));
    const persistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    const task: BoardTask = {
      blocked: false,
      dependencies: [],
      frontMatter: {},
      id: 11,
      priority: "medium",
      status: "in-progress",
      tags: [],
      title: "Arrange inventory",
    };
    persistence.writeReconcilerRuntime({
      boardStatus: task.status,
      instanceId: "sample-11",
      state: "starting",
      taskId: task.id,
    });
    const attention = new DurableAttentionQueue(persistence);
    const start = vi.fn(async () => ({
      awaitingNodeIds: [],
      status: "completed" as const,
    }));
    const lifecycle = {
      plannedStartStage: vi.fn(async () => undefined),
      start,
      validateTaskProviderAliases: vi.fn(async () => undefined),
    } as unknown as ProductionLifecycleRouter;
    let now = 1_000;
    const controller = new ProductionInstanceController(
      { session: {} } as ProductionConfiguration,
      persistence,
      lifecycle,
      {
        repositoryForStage: () => ({
          name: "sample-repository",
          repositoryRoot: root,
        }),
      } as unknown as ProductRoutingCatalog,
      {
        baseBranchForTask: () => "main",
      } as unknown as EpicProjectCoordinator,
      attention,
      {} as never,
      "http://127.0.0.1:4774/mcp",
      async () => "",
      { readHandoffTemplate: async () => "", repositoryRoot: root },
      undefined,
      undefined,
      () => now,
      undefined,
      undefined,
      {
        resolve: vi.fn(async () => ({
          artifactId: "lifecycle:sample",
          blueprintPath: "blueprints/sample.json",
          kind: "resolved" as const,
        })),
        validateTaskProviderAliases: vi.fn(async () => undefined),
      },
    );
    const incidents = new ProductionIncidentCoordinator(
      persistence,
      attention,
      lifecycle,
      controller,
      { now: () => now },
    );

    await controller.synchronize([task]);

    const attentionId =
      "production:instance-start-incomplete:task:11:sample-11";
    expect(attention.list()).toEqual([
      expect.objectContaining({
        attentionId,
        kind: "production-error",
      }),
    ]);
    expect(persistence.getAttention(attentionId)?.payload).toMatchObject({
      code: "instance-start-incomplete",
    });
    await incidents.reconcile([task]);
    expect(
      persistence.incidentFailureRetryReady(
        attentionId,
        now + incidentAdmissionPolicy.retryDelayMilliseconds - 1,
      ),
    ).toBe(false);

    now += incidentAdmissionPolicy.retryDelayMilliseconds - 1;
    await controller.synchronize([task]);
    expect(start).not.toHaveBeenCalled();

    now += 1;
    expect(persistence.incidentFailureRetryReady(attentionId, now)).toBe(true);
    await controller.synchronize([task]);

    expect(start).toHaveBeenCalledOnce();
    expect(persistence.listReconcilerRuntime()).toMatchObject([
      { instanceId: "sample-11", state: "done" },
    ]);
    expect(attention.list()).toEqual([]);
    expect(persistence.incidentFailureRetryReady(attentionId, now)).toBe(false);
    persistence.close();
  });

  it("resumes synchronization after an open breaker and a failed incident", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-open-breaker-"));
    const persistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    const task: BoardTask = {
      blocked: false,
      dependencies: [],
      frontMatter: {},
      id: 12,
      priority: "medium",
      status: "in-progress",
      tags: [],
      title: "Arrange inventory",
    };
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
    persistence.writeReconcilerRuntime({
      boardStatus: task.status,
      instanceId: "sample-12",
      state: "running",
      taskId: task.id,
    });
    const attention = new DurableAttentionQueue(persistence);
    const attentionId =
      "production:instance-synchronization-failed:task:12:sample-12";
    await attention.raise({
      attentionId,
      code: "instance-synchronization-failed",
      error: { cause: null, message: "Synthetic failure", name: "Error" },
      instanceId: "sample-12",
      kind: "production-error",
      message: "Synthetic failure",
      taskId: task.id,
    });
    const failure = {
      attentionId,
      code: "instance-synchronization-failed",
      failureThreshold: 3,
      retryDelayMilliseconds: 100,
    };
    persistence.observeIncidentFailure({ ...failure, observedAt: 1_000 });
    persistence.observeIncidentFailure({ ...failure, observedAt: 1_100 });
    persistence.observeIncidentFailure({ ...failure, observedAt: 1_200 });
    persistence.writeIncidentRuntime({
      accepted: false,
      attentionId,
      code: failure.code,
      createdAt: 1_200,
      incidentId: productionErrorIncidentId(attentionId),
      occurrence: 1,
      rejectionOperationIds: [],
      state: "failed",
      taskId: task.id,
    });
    let now = 1_299;
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
      undefined,
      undefined,
      () => now,
    );

    await controller.synchronize([task]);
    expect(attention.list()).toHaveLength(1);

    now = 1_300;
    await controller.synchronize([task]);

    expect(attention.list()).toEqual([]);
    expect(persistence.incidentFailureRetryReady(attentionId, now)).toBe(false);
    expect(attention.reopen(attentionId)).toBe(true);
    expect(
      persistence.observeIncidentFailure({ ...failure, observedAt: now }),
    ).toMatchObject({ failureCount: 1, kind: "retry-scheduled" });
    persistence.close();
  });

  it.each(["per-code-cooldown", "concurrency-cap"] as const)(
    "resumes synchronization and resolves after %s suppresses incident admission",
    async (suppressionReason) => {
      root = await mkdtemp(join(tmpdir(), "heddle-suppressed-incident-"));
      const persistence = new SqlitePersistence({
        stateDirectory: join(root, "state"),
      });
      const task: BoardTask = {
        blocked: false,
        dependencies: [],
        frontMatter: {},
        id: 12,
        priority: "medium",
        status: "in-progress",
        tags: [],
        title: "Arrange inventory",
      };
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
      persistence.writeReconcilerRuntime({
        boardStatus: task.status,
        instanceId: "sample-12",
        state: "running",
        taskId: task.id,
      });
      const attention = new DurableAttentionQueue(persistence);
      const attentionId =
        "production:instance-synchronization-failed:task:12:sample-12";
      await attention.raise({
        attentionId,
        code: "instance-synchronization-failed",
        error: { cause: null, message: "Synthetic failure", name: "Error" },
        instanceId: "sample-12",
        kind: "production-error",
        message: "Synthetic failure",
        taskId: task.id,
      });
      const failure = {
        attentionId,
        code: "instance-synchronization-failed",
        failureThreshold: 3,
        retryDelayMilliseconds: 100,
      };
      persistence.observeIncidentFailure({ ...failure, observedAt: 1_000 });
      persistence.observeIncidentFailure({ ...failure, observedAt: 1_100 });
      persistence.observeIncidentFailure({ ...failure, observedAt: 1_200 });
      const limitingAttentionId = `limiting-${suppressionReason}`;
      persistence.writeIncidentRuntime({
        accepted: false,
        attentionId: limitingAttentionId,
        code:
          suppressionReason === "per-code-cooldown"
            ? failure.code
            : "unrelated-failure",
        createdAt: 1_200,
        incidentId: productionErrorIncidentId(limitingAttentionId),
        occurrence: 1,
        rejectionOperationIds: [],
        state: suppressionReason === "per-code-cooldown" ? "done" : "waiting",
        taskId: 19,
      });
      const admission = persistence.admitIncident({
        attentionId,
        code: failure.code,
        cooldownMilliseconds:
          suppressionReason === "per-code-cooldown" ? 100 : 0,
        createdAt: 1_200,
        incidentId: productionErrorIncidentId(attentionId),
        maximumConcurrent: suppressionReason === "concurrency-cap" ? 1 : 3,
        occurrence: 1,
        sourceInstanceId: "sample-12",
        taskId: task.id,
      });
      expect(admission).toEqual({
        kind: "suppressed",
        reason: suppressionReason,
      });
      let now = 1_299;
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
        undefined,
        undefined,
        () => now,
      );

      await controller.synchronize([task]);
      expect(attention.list()).toHaveLength(1);
      now = 1_300;
      await controller.synchronize([task]);

      expect(attention.list()).toEqual([]);
      expect(
        persistence
          .listIncidentRuntime()
          .filter((runtime) => runtime.attentionId === attentionId),
      ).toEqual([]);
      expect(persistence.incidentFailureRetryReady(attentionId, now)).toBe(
        false,
      );
      expect(attention.reopen(attentionId)).toBe(true);
      expect(
        persistence.observeIncidentFailure({ ...failure, observedAt: now }),
      ).toMatchObject({ failureCount: 1, kind: "retry-scheduled" });
      persistence.close();
    },
  );

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

  it("keeps an exclusive initial stage choice unbound and effect-free across restart", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-exclusive-start-"));
    const blueprint: LifecycleBlueprint = {
      id: "exclusive-sample",
      nodes: [
        { id: "choose", uses: "choose" },
        { config: { joinStrategy: "any" }, id: "left", uses: "wait" },
        { config: { joinStrategy: "any" }, id: "right", uses: "wait" },
        { id: "finish", uses: "finish" },
      ],
      edges: [
        {
          condition: "result.output.dispositions.left",
          disposition: "left",
          source: "choose",
          target: "left",
        },
        {
          condition: "result.output.dispositions.right",
          disposition: "right",
          source: "choose",
          target: "right",
        },
        {
          condition: "result.output.dispositions.complete",
          description: "Complete the left sample",
          disposition: "complete",
          source: "left",
          target: "finish",
        },
        {
          condition: "result.output.dispositions.complete",
          description: "Complete the right sample",
          disposition: "complete",
          source: "right",
          target: "finish",
        },
      ],
    };
    await mkdir(join(root, "blueprints"));
    const artifact: Partial<LifecycleBlueprint> = { ...blueprint };
    delete artifact.id;
    await writeFile(
      join(root, "blueprints", "exclusive.json"),
      JSON.stringify(artifact),
    );
    await execute("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: root,
    });
    await execute("git", ["add", "blueprints/exclusive.json"], {
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
        "Add exclusive lifecycle fixture",
      ],
      { cwd: root },
    );
    const choose = vi.fn<LifecycleEffect>(async () => ({
      dispositions: { right: true },
    }));
    const task: BoardTask = {
      blocked: false,
      dependencies: [],
      frontMatter: {},
      id: 3,
      priority: "medium",
      status: "todo",
      tags: [],
      title: "Arrange inventory",
    };
    const attempt = async (): Promise<void> => {
      const persistence = new SqlitePersistence({
        stateDirectory: join(root, "state"),
      });
      const lifecycle = new ProductionLifecycleRouter({
        effects: { choose, finish: async () => ({}) },
        persistence,
        repositoryRoot: root,
        sourceRef: "HEAD",
      });
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

      await expect(
        controller.start({
          blueprintPath: "blueprints/exclusive.json",
          instanceId: "task-3",
          task,
        }),
      ).rejects.toThrow("multiple possible initial session stages");
      expect(persistence.listInstances()).toEqual([]);
      expect(persistence.listReconcilerRuntime()).toEqual([]);
      expect(persistence.listSessionRuntime()).toEqual([]);
      persistence.close();
    };

    await attempt();
    await attempt();

    expect(choose).not.toHaveBeenCalled();
  });
});
