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
import {
  SqlitePersistence,
  type IncidentRuntimeRecord,
  type JsonValue,
} from "../persistence/index.js";
import { DurableAttentionQueue } from "./durable-adapters.js";
import {
  productionErrorAttention,
  operatorOnlyProductionErrorCodes,
  productionErrorIncidentId,
  type ProductionErrorCode,
} from "./error-visibility.js";
import {
  incidentAdmissionPolicy,
  ProductionIncidentCoordinator,
  sanitizeIncidentValue,
} from "./incident-coordinator.js";
import type { ProductionInstanceController } from "./instance-controller.js";
import type { ProductionLifecycleRouter } from "./lifecycle-router.js";

const task = (id = 17): BoardTask => ({
  blocked: false,
  dependencies: [],
  frontMatter: {},
  id,
  priority: "medium",
  status: "in-progress",
  tags: [],
  title: "Arrange inventory",
});

const lifecycleState = (
  stage: string | undefined,
  status: "awaiting" | "completed" = stage === undefined
    ? "completed"
    : "awaiting",
) => ({
  correlationTokens: {},
  flowcraftContext: {
    awaitingNodeIds: stage === undefined ? [] : [stage],
    blueprintBlobHash: "0123456789012345678901234567890123456789",
    blueprintPath: "blueprints/incident.json",
    completedOperations: {},
    executionIds: ["incident-execution"],
    nextTransitionNumber: 2,
    pendingAttentions: [],
    pendingTransition: null,
    serializedContext: "{}",
    status,
  },
  handoffs: [],
  todoState: null,
});

class IncidentHarness {
  readonly activations: string[] = [];
  readonly boardWrites: string[] = [];
  readonly lifecycle: ProductionLifecycleRouter;
  readonly instances: ProductionInstanceController;

  constructor(readonly persistence: SqlitePersistence) {
    this.lifecycle = {
      plannedStartStage: vi.fn(async () => "implement"),
      start: vi.fn(async ({ instanceId }: { instanceId: string }) => {
        if (this.persistence.getInstance(instanceId) === undefined) {
          this.persistence.createInstance(
            instanceId,
            lifecycleState("implement"),
          );
        }
        return this.snapshot(instanceId, "implement");
      }),
      resume: vi.fn(
        async (input: {
          disposition: string;
          instanceId: string;
          operationId: string;
          output?: Record<string, JsonValue>;
        }) => {
          const runtime = this.persistence
            .listIncidentRuntime()
            .find(({ incidentId }) => incidentId === input.instanceId)!;
          const next =
            runtime.stageId === "implement" && input.disposition === "diagnosed"
              ? "review"
              : runtime.stageId === "review" && input.disposition === "approve"
                ? "finalize"
                : runtime.stageId === "review" && input.disposition === "reject"
                  ? "implement"
                  : undefined;
          this.persistence.updateInstance(
            input.instanceId,
            lifecycleState(next),
          );
          return this.snapshot(input.instanceId, next);
        },
      ),
    } as unknown as ProductionLifecycleRouter;
    this.instances = {
      prepareIncidentStart: vi.fn(
        (runtime: IncidentRuntimeRecord, stageId: string) => {
          const activation =
            this.persistence
              .listIncidentRuntime()
              .filter(({ incidentId }) => incidentId === runtime.incidentId)
              .length + this.activations.length;
          const prepared = {
            ...runtime,
            provider: "sample-provider",
            sessionKey: `${runtime.incidentId}:${stageId}:${activation}`,
            stageId,
            state: "starting" as const,
            threadId: `${runtime.incidentId}:${stageId}:thread:${activation}`,
          };
          this.persistence.writeIncidentRuntime(prepared);
          return prepared;
        },
      ),
      activateIncident: vi.fn(
        async (
          _task: BoardTask,
          runtime: IncidentRuntimeRecord,
          stageId: string,
        ) => {
          this.activations.push(stageId);
          this.persistence.writeIncidentRuntime({
            ...runtime,
            stageId,
            state: "waiting",
          });
        },
      ),
    } as unknown as ProductionInstanceController;
  }

  snapshot(instanceId: string, stage: string | undefined): LifecycleSnapshot {
    return {
      awaitingNodeIds: stage === undefined ? [] : [stage],
      blueprintBlobHash: "0123456789012345678901234567890123456789",
      blueprintPath: "blueprints/incident.json",
      executionIds: ["incident-execution"],
      instanceId,
      status: stage === undefined ? "completed" : "awaiting",
      validDispositions: [],
    };
  }
}

describe("production incident coordinator", () => {
  let root = "";
  let persistence: SqlitePersistence | undefined;

  afterEach(async () => {
    persistence?.close();
    persistence = undefined;
    if (root !== "") await rm(root, { force: true, recursive: true });
    root = "";
  });

  const createSubject = async (
    options: {
      admissionPolicy?: typeof incidentAdmissionPolicy;
      authority?: Record<string, JsonValue>;
      immediateEscalationCodes?: ReadonlySet<string>;
      now?: () => number;
    } = {},
  ) => {
    root = await mkdtemp(join(tmpdir(), "heddle-incident-"));
    persistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    const attention = new DurableAttentionQueue(persistence);
    const harness = new IncidentHarness(persistence);
    const coordinator = new ProductionIncidentCoordinator(
      persistence,
      attention,
      harness.lifecycle,
      harness.instances,
      {
        admissionPolicy: {
          ...incidentAdmissionPolicy,
          failureThreshold: 1,
          retryDelayMilliseconds: 0,
        },
        ...options,
      },
    );
    return { attention, coordinator, harness };
  };

  const raise = async (
    attention: DurableAttentionQueue,
    code: ProductionErrorCode = "task-reconciliation-failed",
    error: unknown = new Error("Synthetic condition"),
    taskId = 17,
  ) => {
    const source = productionErrorAttention({
      code,
      error,
      instanceId: `sample-instance-${taskId}`,
      summary: "Production condition",
      taskId,
      varyByError: true,
    });
    await attention.raise(source);
    return source;
  };

  it("converges repeated raise, restart, and replay on one incident with no child-task board write", async () => {
    const { attention, coordinator, harness } = await createSubject();
    const source = await raise(attention);

    await coordinator.reconcile([task()]);
    await coordinator.reconcile([task()]);
    const restarted = new ProductionIncidentCoordinator(
      persistence!,
      attention,
      harness.lifecycle,
      harness.instances,
    );
    await restarted.reconcile([task()]);

    expect(persistence!.listIncidentRuntime()).toEqual([
      expect.objectContaining({
        attentionId: source.attentionId,
        incidentId: productionErrorIncidentId(source.attentionId),
        state: "waiting",
      }),
    ]);
    expect(harness.activations).toEqual(["implement"]);
    expect(harness.boardWrites).toEqual([]);
  });

  it.each(["done", "failed"] as const)(
    "starts a fresh incident occurrence after a %s occurrence and restart",
    async (terminalState) => {
      const { attention, coordinator, harness } = await createSubject({
        admissionPolicy: {
          ...incidentAdmissionPolicy,
          cooldownMilliseconds: 0,
          failureThreshold: 1,
          retryDelayMilliseconds: 0,
        },
      });
      const source = await raise(attention);
      const originalAttention = persistence!.getAttention(source.attentionId)!;
      await coordinator.reconcile([task()]);
      const first = persistence!.listIncidentRuntime()[0]!;
      persistence!.writeIncidentRuntime({ ...first, state: terminalState });
      attention.resolve(source.attentionId);
      attention.reopen(source.attentionId);

      await coordinator.reconcile([task()]);
      const restarted = new ProductionIncidentCoordinator(
        persistence!,
        attention,
        harness.lifecycle,
        harness.instances,
        {
          admissionPolicy: {
            ...incidentAdmissionPolicy,
            cooldownMilliseconds: 0,
            failureThreshold: 1,
            retryDelayMilliseconds: 0,
          },
        },
      );
      await restarted.reconcile([task()]);

      const incidents = persistence!.listIncidentRuntime();
      expect(incidents).toEqual([
        { ...first, state: terminalState },
        expect.objectContaining({
          attentionId: source.attentionId,
          incidentId: productionErrorIncidentId(source.attentionId, 2),
          occurrence: 2,
          state: "waiting",
        }),
      ]);
      expect(incidents[1]?.incidentId).not.toBe(first.incidentId);
      expect(persistence!.getInstance(first.incidentId)).toBeDefined();
      expect(persistence!.getInstance(incidents[1]!.incidentId)).toBeDefined();
      expect(persistence!.getAttention(source.attentionId)).toMatchObject({
        attentionId: originalAttention.attentionId,
        payload: originalAttention.payload,
        recordedAt: originalAttention.recordedAt,
      });
      expect(harness.activations).toEqual(["implement", "implement"]);
      expect(
        vi.mocked(harness.lifecycle.start).mock.calls[1]?.[0],
      ).toMatchObject({
        initialContext: {
          incident: {
            incidentId: incidents[1]!.incidentId,
            occurrence: 2,
          },
        },
      });

      persistence!.writeIncidentRuntime({
        ...incidents[1]!,
        state: terminalState,
      });
      attention.resolve(source.attentionId);
      attention.reopen(source.attentionId);
      await coordinator.reconcile([task()]);

      expect(persistence!.listIncidentRuntime()[2]).toMatchObject({
        incidentId: productionErrorIncidentId(source.attentionId, 3),
        occurrence: 3,
        state: "waiting",
      });
      expect(harness.activations).toEqual([
        "implement",
        "implement",
        "implement",
      ]);
    },
  );

  it("opens the breaker only after later-pass retries reach the configured threshold", async () => {
    let observedAt = 1_000;
    const { attention, coordinator, harness } = await createSubject({
      admissionPolicy: {
        ...incidentAdmissionPolicy,
        failureThreshold: 3,
        retryDelayMilliseconds: 100,
      },
      now: () => observedAt,
    });
    await raise(attention, "unanticipated-provider-failure");

    await coordinator.reconcile([task()]);
    await coordinator.reconcile([task()]);
    expect(persistence!.listIncidentRuntime()).toEqual([]);

    observedAt += 100;
    await coordinator.reconcile([task()]);
    expect(persistence!.listIncidentRuntime()).toEqual([]);

    observedAt += 100;
    await coordinator.reconcile([task()]);
    expect(harness.activations).toEqual(["implement"]);
  });

  it("allows a known failure shape to short-circuit the default retry policy", async () => {
    const { attention, coordinator, harness } = await createSubject({
      admissionPolicy: {
        ...incidentAdmissionPolicy,
        failureThreshold: 5,
        retryDelayMilliseconds: 100,
      },
      immediateEscalationCodes: new Set(["known-fatal-shape"]),
    });
    await raise(attention, "known-fatal-shape");

    await coordinator.reconcile([task()]);

    expect(harness.activations).toEqual(["implement"]);
  });

  it("admits a repeated dead-session attention without a production-error declaration", async () => {
    const { attention, coordinator, harness } = await createSubject();
    persistence!.writeReconcilerRuntime({
      boardStatus: "review",
      instanceId: "sample-instance-17",
      sessionKey: "sample-instance-17:review:1",
      stageId: "review",
      state: "waiting",
      taskId: 17,
      threadId: "sample-thread",
    });
    await attention.raise({
      attentionId: "dead-session-attention",
      instanceId: "sample-instance-17",
      kind: "failed",
      message: "Session failed before lifecycle advance",
      sessionKey: "sample-instance-17:review:1",
      threadId: "sample-thread",
    });

    await coordinator.reconcile([task()]);

    expect(harness.activations).toEqual(["implement"]);
    expect(persistence!.listIncidentRuntime()).toEqual([
      expect.objectContaining({
        attentionId: "dead-session-attention",
        code: "session-failed",
        taskId: 17,
      }),
    ]);
  });

  it("indexes runtime sources once for all attention in an admission pass", async () => {
    const { attention, coordinator } = await createSubject({
      admissionPolicy: {
        ...incidentAdmissionPolicy,
        failureThreshold: 3,
      },
    });
    for (const taskId of [17, 18]) {
      const instanceId = `sample-instance-${taskId}`;
      persistence!.writeReconcilerRuntime({
        boardStatus: "review",
        instanceId,
        sessionKey: `${instanceId}:review:1`,
        stageId: "review",
        state: "waiting",
        taskId,
        threadId: `sample-thread-${taskId}`,
      });
      await attention.raise({
        attentionId: `dead-session-attention-${taskId}`,
        instanceId,
        kind: "failed",
        message: "Session failed before lifecycle advance",
        sessionKey: `${instanceId}:review:1`,
        threadId: `sample-thread-${taskId}`,
      });
    }
    const listReconcilerRuntime = vi.spyOn(
      persistence!,
      "listReconcilerRuntime",
    );
    const listIncidentRuntime = vi.spyOn(persistence!, "listIncidentRuntime");

    await coordinator.reconcile([task(17), task(18)]);

    expect(listReconcilerRuntime).toHaveBeenCalledOnce();
    expect(listIncidentRuntime).toHaveBeenCalledTimes(2);
  });

  it("supplies observable authority and prohibitions to the incident handoff", async () => {
    const { attention, coordinator, harness } = await createSubject({
      authority: {
        blueprintRepositoryRoot: "/tmp/sample-blueprints",
        githubIssueRepository: "sample-owner/sample-repository",
        workspaceRoot: "/tmp/sample-workspace",
      },
    });
    await raise(attention);

    await coordinator.reconcile([task()]);

    expect(vi.mocked(harness.lifecycle.start).mock.calls[0]?.[0]).toMatchObject(
      {
        initialContext: {
          incident: {
            authority: {
              blueprintRepositoryRoot: "/tmp/sample-blueprints",
              githubIssueRepository: "sample-owner/sample-repository",
              workspaceRoot: "/tmp/sample-workspace",
            },
            prohibitions: expect.arrayContaining([
              "read-move-or-write-secrets",
              "perform-unobservable-effect",
            ]),
          },
        },
      },
    );
  });

  it("dispatches unclassified failures and keeps only the explicit floor out", async () => {
    const { attention, coordinator } = await createSubject();
    const floorCodes = [
      "scheduler-pass-failed",
      "dynamic-task-authority-failed",
    ] as const;
    expect(
      floorCodes.every((code) => operatorOnlyProductionErrorCodes.has(code)),
    ).toBe(true);
    for (const [index, code] of floorCodes.entries()) {
      await raise(
        attention,
        code,
        new Error(`Synthetic floor ${index}`),
        index + 1,
      );
    }

    await coordinator.reconcile([task(1), task(2)]);

    expect(persistence!.listIncidentRuntime()).toEqual([]);

    const source = await raise(
      attention,
      "unanticipated-provider-failure",
      new Error("Synthetic unanticipated failure"),
      3,
    );
    await coordinator.reconcile([task(1), task(2), task(3)]);
    expect(persistence!.listIncidentRuntime()).toEqual([
      expect.objectContaining({ attentionId: source.attentionId, taskId: 3 }),
    ]);
  });

  it("contains a varying-text storm and retains every suppressed attention", async () => {
    const now = vi.fn(() => 10_000);
    const { attention, coordinator } = await createSubject({ now });
    for (let index = 0; index < 5; index += 1) {
      await raise(
        attention,
        "task-reconciliation-failed",
        new Error(`Varying synthetic failure ${index}`),
      );
    }

    await coordinator.reconcile([task()]);

    expect(persistence!.listIncidentRuntime()).toHaveLength(1);
    expect(persistence!.listAttention()).toHaveLength(5);
  });

  it("does not recursively dispatch an eligible error whose source is an incident", async () => {
    const { attention, coordinator } = await createSubject();
    await raise(attention);
    await coordinator.reconcile([task()]);
    const runtime = persistence!.listIncidentRuntime()[0]!;
    await attention.raise(
      productionErrorAttention({
        code: "lifecycle-execution-failed",
        error: new Error("Synthetic incident lifecycle failure"),
        instanceId: runtime.incidentId,
        summary: "Incident lifecycle failed",
        taskId: runtime.taskId,
      }),
    );

    await coordinator.reconcile([task()]);

    expect(persistence!.listIncidentRuntime()).toHaveLength(1);
  });

  it("does not reactivate a failed incident from its retained source attention", async () => {
    const { attention, coordinator, harness } = await createSubject();
    const source = await raise(attention);
    await coordinator.reconcile([task()]);
    await coordinator.resume({
      disposition: "diagnosed",
      instanceId: source.incidentId!,
      operationId: "diagnose-once",
      output: {
        conditionState: "live",
        proposedActions: [{ kind: "github-issue", summary: "Record it" }],
        rootCauseAnalysis: "Synthetic analysis",
      },
    });
    vi.mocked(harness.instances.activateIncident).mockRejectedValueOnce(
      new Error("Synthetic finalizer activation failure"),
    );

    await coordinator.resume({
      disposition: "approve",
      instanceId: source.incidentId!,
      operationId: "approve-once",
    });
    expect(persistence!.listIncidentRuntime()[0]?.state).toBe("failed");
    expect(harness.instances.activateIncident).toHaveBeenCalledTimes(3);

    await coordinator.reconcile([task()]);
    expect(harness.instances.activateIncident).toHaveBeenCalledTimes(3);
    expect(persistence!.hasAttention(source.attentionId)).toBe(true);
  });

  it("removes correlation tokens, configured secrets, and credential-bearing URLs from incident values", () => {
    const sanitized = sanitizeIncidentValue(
      {
        error:
          "token-synthetic access-synthetic https://actor:password@host.invalid/path",
      },
      ["token-synthetic", "access-synthetic"],
    );
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("token-synthetic");
    expect(serialized).not.toContain("access-synthetic");
    expect(serialized).not.toContain("password");
    expect(serialized).toContain("[redacted]");
  });
});

describe("incident admission policy", () => {
  it("declares positive storm bounds", () => {
    expect(incidentAdmissionPolicy.maximumConcurrent).toBeGreaterThan(0);
    expect(incidentAdmissionPolicy.cooldownMilliseconds).toBeGreaterThan(0);
    expect(incidentAdmissionPolicy.failureThreshold).toBeGreaterThan(1);
    expect(incidentAdmissionPolicy.retryDelayMilliseconds).toBeGreaterThan(0);
  });
});
