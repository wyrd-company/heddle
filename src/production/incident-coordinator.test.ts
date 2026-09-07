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
import { ProductionAttentionActions } from "./attention-actions.js";
import { projectProductionAttention } from "./attention-projection.js";
import {
  productionErrorAttention,
  productionErrorCodeDeclarations,
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
      commandAvailable?: (name: string) => Promise<boolean>;
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
      options,
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

  it("enumerates the centralized floor declarations and dispatches neither floor error", async () => {
    const { attention, coordinator } = await createSubject();
    const floorCodes = [
      "scheduler-pass-failed",
      "dynamic-task-authority-failed",
    ] as const;
    expect(
      floorCodes.map((code) => productionErrorCodeDeclarations[code]),
    ).toEqual([{ incidentEligible: false }, { incidentEligible: false }]);
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

  it("accepts review, runs one finalize stage occurrence, and resolves the retained attention with incident justification", async () => {
    const commandAvailable = vi.fn(async () => true);
    const { attention, coordinator, harness } = await createSubject({
      commandAvailable,
    });
    const source = await raise(attention);
    await coordinator.reconcile([task()]);
    await coordinator.resume({
      disposition: "diagnosed",
      instanceId: source.incidentId!,
      operationId: "diagnose-once",
      output: {
        conditionState: "live",
        proposedActions: [
          { kind: "github-issue", summary: "Record the condition" },
        ],
        rootCauseAnalysis: "Synthetic analysis",
      },
    });
    expect(commandAvailable).not.toHaveBeenCalled();
    await coordinator.resume({
      disposition: "approve",
      instanceId: source.incidentId!,
      operationId: "review-once",
    });
    await coordinator.reconcile([task()]);

    expect(commandAvailable).toHaveBeenCalledTimes(1);
    expect(harness.activations).toEqual(["implement", "review", "finalize"]);
    await coordinator.resume({
      disposition: "complete",
      instanceId: source.incidentId!,
      operationId: "finalize-once",
    });

    expect(persistence!.listAttention()).toEqual([]);
    expect(persistence!.getAttention(source.attentionId)).toEqual(
      expect.objectContaining({
        attentionId: source.attentionId,
        resolutionJustification: source.incidentId,
        resolvedAt: expect.any(String),
      }),
    );
    expect(persistence!.listIncidentRuntime()[0]?.state).toBe("done");
  });

  it("retains diagnosis and acceptance intent when the process stops after each lifecycle transition", async () => {
    const { attention, coordinator, harness } = await createSubject({
      commandAvailable: async () => true,
    });
    const source = await raise(attention);
    await coordinator.reconcile([task()]);
    const underlyingResume = harness.lifecycle.resume.bind(harness.lifecycle);
    vi.spyOn(harness.lifecycle, "resume").mockImplementationOnce(
      async (input) => {
        await underlyingResume(input);
        throw new Error("Injected stop after diagnosis transition");
      },
    );

    await expect(
      coordinator.resume({
        disposition: "diagnosed",
        instanceId: source.incidentId!,
        operationId: "diagnose-before-stop",
        output: {
          conditionState: "live",
          proposedActions: [
            { kind: "github-issue", summary: "Record the condition" },
          ],
          rootCauseAnalysis: "Synthetic restart analysis",
        },
      }),
    ).rejects.toThrow("Injected stop");
    await coordinator.reconcile([task()]);
    expect(persistence!.listIncidentRuntime()[0]).toMatchObject({
      diagnosis: { rootCauseAnalysis: "Synthetic restart analysis" },
      stageId: "review",
      state: "waiting",
    });

    vi.spyOn(harness.lifecycle, "resume").mockImplementationOnce(
      async (input) => {
        await underlyingResume(input);
        throw new Error("Injected stop after acceptance transition");
      },
    );
    await expect(
      coordinator.resume({
        disposition: "approve",
        instanceId: source.incidentId!,
        operationId: "approve-before-stop",
      }),
    ).rejects.toThrow("Injected stop");
    await coordinator.reconcile([task()]);

    expect(persistence!.listIncidentRuntime()[0]).toMatchObject({
      accepted: true,
      stageId: "finalize",
      state: "waiting",
    });
    expect(harness.activations).toEqual(["implement", "review", "finalize"]);
  });

  it("returns one rejected review to implement and escalates when the review bound is exhausted", async () => {
    const { attention, coordinator, harness } = await createSubject();
    const source = await raise(attention);
    await coordinator.reconcile([task()]);
    const runtime = persistence!.listIncidentRuntime()[0]!;
    persistence!.writeIncidentRuntime({
      ...runtime,
      diagnosis: {
        conditionState: "undetermined",
        proposedActions: [],
        rootCauseAnalysis: "Synthetic analysis",
      },
      stageId: "review",
      state: "waiting",
    });
    persistence!.updateInstance(runtime.incidentId, lifecycleState("review"));

    await coordinator.resume({
      disposition: "reject",
      instanceId: runtime.incidentId,
      operationId: "reject-one",
      output: { findings: ["Add direct evidence"] },
    });
    expect(harness.activations.at(-1)).toBe("implement");
    const rejected = persistence!.listIncidentRuntime()[0]!;
    persistence!.writeIncidentRuntime({
      ...rejected,
      rejectionOperationIds: ["reject-one", "reject-two", "reject-three"],
      stageId: "review",
      state: "waiting",
    });
    persistence!.updateInstance(runtime.incidentId, lifecycleState("review"));

    await expect(
      coordinator.resume({
        disposition: "reject",
        instanceId: runtime.incidentId,
        operationId: "reject-four",
        output: { findings: ["Still insufficient"] },
      }),
    ).rejects.toThrow("rejection bound");

    expect(persistence!.hasAttention(source.attentionId)).toBe(true);
    expect(
      persistence!
        .listAttention()
        .some(({ payload }) =>
          JSON.stringify(payload).includes("incident-execution-failed"),
        ),
    ).toBe(true);
    expect(persistence!.listIncidentRuntime()[0]?.state).toBe("failed");
  });

  it("fails finalize closed when gh is absent and does not recursively incident the failure", async () => {
    const commandAvailable = vi.fn(async () => false);
    const { attention, coordinator } = await createSubject({
      commandAvailable,
    });
    const source = await raise(attention);
    await coordinator.reconcile([task()]);
    const runtime = persistence!.listIncidentRuntime()[0]!;
    persistence!.writeIncidentRuntime({
      ...runtime,
      accepted: true,
      diagnosis: {
        conditionState: "live",
        proposedActions: [{ kind: "github-issue", summary: "Record it" }],
        rootCauseAnalysis: "Synthetic analysis",
      },
      stageId: "review",
      state: "waiting",
    });
    persistence!.updateInstance(runtime.incidentId, lifecycleState("review"));

    await coordinator.resume({
      disposition: "approve",
      instanceId: runtime.incidentId,
      operationId: "review-once",
    });
    await coordinator.reconcile([task()]);

    const messages = persistence!
      .listAttention()
      .map(({ payload }) => JSON.stringify(payload));
    expect(
      messages.some((message) => message.includes("missing from PATH: gh")),
    ).toBe(true);
    expect(persistence!.listIncidentRuntime()).toHaveLength(1);
    await coordinator.reconcile([task()]);
    expect(persistence!.listIncidentRuntime()).toHaveLength(1);
    expect(persistence!.hasAttention(source.attentionId)).toBe(true);
  });

  it("refuses to activate finalize before review acceptance", async () => {
    const { attention, coordinator, harness } = await createSubject();
    await raise(attention);
    await coordinator.reconcile([task()]);
    const runtime = persistence!.listIncidentRuntime()[0]!;
    persistence!.writeIncidentRuntime({
      ...runtime,
      accepted: false,
      diagnosis: {
        conditionState: "live",
        proposedActions: [],
        rootCauseAnalysis: "Synthetic analysis",
      },
      stageId: "review",
      state: "waiting",
    });
    persistence!.updateInstance(runtime.incidentId, lifecycleState("finalize"));

    await coordinator.reconcile([task()]);

    expect(harness.activations).toEqual(["implement"]);
    expect(persistence!.listIncidentRuntime()[0]?.state).toBe("failed");
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

  it("creates no production-capable finalizer before durable proposal approval and activates it once after approval replay", async () => {
    const { attention, coordinator, harness } = await createSubject();
    const source = await raise(attention);
    await coordinator.reconcile([task()]);
    await coordinator.resume({
      disposition: "diagnosed",
      instanceId: source.incidentId!,
      operationId: "diagnose-once",
      output: {
        conditionState: "live",
        proposedActions: [
          { kind: "production-mutation", summary: "Repair synthetic state" },
        ],
        rootCauseAnalysis: "Synthetic analysis",
      },
    });
    await coordinator.resume({
      disposition: "approve",
      instanceId: source.incidentId!,
      operationId: "approve-once",
    });

    expect(harness.activations).toEqual(["implement", "review"]);
    expect(
      vi
        .mocked(harness.instances.prepareIncidentStart)
        .mock.calls.map(([, stageId]) => stageId),
    ).toEqual(["implement", "review"]);
    const approvalRecord = persistence!
      .listAttention()
      .find(({ payload }) =>
        JSON.stringify(payload).includes(
          "incident-production-mutation-approval",
        ),
      )!;
    const approval = projectProductionAttention(
      approvalRecord,
      persistence!.listReconcilerRuntime(),
      undefined,
      undefined,
      persistence!.listIncidentRuntime(),
    );
    expect(approval).toMatchObject({
      actions: [
        expect.objectContaining({
          actionId: "incident.production-mutation.approve",
        }),
      ],
      instanceId: source.incidentId,
      taskId: 17,
    });
    const actions = new ProductionAttentionActions(
      persistence!,
      attention,
      { answerAsOperator: vi.fn() } as never,
      {} as never,
    );
    await actions.execute({
      action: approval.actions[0]!,
      attention: approval,
    });

    await coordinator.reconcile([task()]);
    const restarted = new ProductionIncidentCoordinator(
      persistence!,
      attention,
      harness.lifecycle,
      harness.instances,
    );
    await restarted.reconcile([task()]);
    expect(harness.activations).toEqual(["implement", "review", "finalize"]);
    expect(
      vi
        .mocked(harness.instances.prepareIncidentStart)
        .mock.calls.map(([, stageId]) => stageId),
    ).toEqual(["implement", "review", "finalize"]);
    expect(
      persistence!
        .replayEvents(source.incidentId!)
        .filter(
          ({ type }) =>
            type === "operator:incident-production-mutation-approved",
        ),
    ).toHaveLength(1);

    await coordinator.resume({
      disposition: "complete",
      instanceId: source.incidentId!,
      operationId: "finalize-once",
    });
    expect(
      persistence!
        .listAttention()
        .some(({ attentionId }) => attentionId === source.attentionId),
    ).toBe(false);
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
  it("declares positive storm and review bounds", () => {
    expect(incidentAdmissionPolicy.maximumConcurrent).toBeGreaterThan(0);
    expect(incidentAdmissionPolicy.cooldownMilliseconds).toBeGreaterThan(0);
    expect(incidentAdmissionPolicy.maximumReviewRejections).toBeGreaterThan(0);
  });
});
