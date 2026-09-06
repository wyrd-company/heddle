// ---
// relationships:
//   implements: heddle
// ---

import { describe, expect, it, vi } from "vitest";

import { DispatchPacingGate } from "../pacing/index.js";
import { EpicOperationCoordinator } from "../production/index.js";
import { fixture, task } from "./reconciler.test-support.js";

const pacing = (
  usage: { used: number; windowStartedAt: number },
  now: () => number = () => 2_000,
  maxConcurrentSessions: number = 1,
) => ({
  evaluator: new DispatchPacingGate(
    {
      defaultProvider: "provider-a",
      maxConcurrentSessions,
      providerBudgets: { "provider-a": { usageLimit: 80 } },
      subagents: { maxDepth: 2, maxFanOut: 2 },
      usageWindowHours: 5,
    },
    { readFiveHourWindow: async () => ({ ...usage }) },
    now,
  ),
});

describe("Reconciler", () => {
  it("admits one trusted delivery child after retained UAT terminal proof", async () => {
    const epic = task(1, "uat", { tags: ["type:epic"] });
    const acceptance = task(2, "done", { parent: epic.id, tags: ["uat"] });
    const followUp = task(3, "backlog", {
      lifecycle: "label-replacement",
      parent: epic.id,
      tags: ["type:follow-up"],
    });
    const subject = fixture([epic, acceptance, followUp], {
      coordinated: true,
      trustedTaskIds: [followUp.id],
    });
    subject.instances.instances.push({
      boardStatus: "done",
      instanceId: "task-2",
      state: "done",
      taskId: acceptance.id,
    });

    await subject.reconciler.reconcile();
    await subject.reconciler.reconcile();

    expect(epic.status).toBe("uat");
    expect(followUp.status).toBe("todo");
    expect(subject.instances.starts.map(({ task }) => task.id)).toEqual([
      followUp.id,
    ]);
    expect(subject.attention.entries).toHaveLength(0);
  });

  it("keeps trusted delivery quiet while UAT remains active", async () => {
    const epic = task(4, "uat", { tags: ["type:epic"] });
    const acceptance = task(5, "in-progress", {
      parent: epic.id,
      tags: ["uat"],
    });
    const followUp = task(6, "backlog", {
      lifecycle: "label-replacement",
      parent: epic.id,
      tags: ["type:follow-up"],
    });
    const subject = fixture([epic, acceptance, followUp], {
      coordinated: true,
      trustedTaskIds: [followUp.id],
    });
    subject.instances.instances.push({
      boardStatus: "in-progress",
      instanceId: "task-5",
      state: "waiting",
      taskId: acceptance.id,
    });

    await subject.reconciler.reconcile();

    expect(followUp.status).toBe("backlog");
    expect(subject.instances.starts).toEqual([]);
    expect(subject.attention.entries).toHaveLength(0);
  });

  it("fails closed when a done UAT task has no retained terminal runtime", async () => {
    const epic = task(7, "uat", { tags: ["type:epic"] });
    const acceptance = task(8, "done", { parent: epic.id, tags: ["uat"] });
    const followUp = task(9, "backlog", {
      lifecycle: "label-replacement",
      parent: epic.id,
      tags: ["type:follow-up"],
    });
    const subject = fixture([epic, acceptance, followUp], {
      coordinated: true,
      trustedTaskIds: [followUp.id],
    });

    await subject.reconciler.reconcile();
    await subject.reconciler.reconcile();

    expect(followUp.status).toBe("backlog");
    expect(subject.instances.starts).toEqual([]);
    expect([...subject.attention.entries.values()]).toEqual([
      expect.objectContaining({
        attentionId: "epic:7:acceptance:uat-terminal-unverified",
        code: "uat-terminal-unverified",
      }),
    ]);
  });

  it("admits only exact trusted work from a mixed set", async () => {
    const epic = task(10, "uat", { tags: ["type:epic"] });
    const acceptance = task(11, "done", { parent: epic.id, tags: ["uat"] });
    const trusted = task(12, "backlog", {
      lifecycle: "label-replacement",
      parent: epic.id,
      tags: ["type:follow-up"],
    });
    const untrusted = task(13, "backlog", {
      lifecycle: "surface-cleaning",
      parent: epic.id,
      tags: ["type:follow-up"],
    });
    const subject = fixture([epic, acceptance, trusted, untrusted], {
      coordinated: true,
      trustedTaskIds: [trusted.id],
    });
    subject.instances.instances.push({
      boardStatus: "done",
      instanceId: "task-11",
      state: "done",
      taskId: acceptance.id,
    });

    await subject.reconciler.reconcile();
    await subject.reconciler.reconcile();

    expect(trusted.status).toBe("todo");
    expect(untrusted.status).toBe("backlog");
    expect(subject.instances.starts.map(({ task }) => task.id)).toEqual([
      trusted.id,
    ]);
    expect([...subject.attention.entries.values()]).toEqual([
      expect.objectContaining({
        attentionId: "epic:10:acceptance:delivery-child-incomplete",
        code: "uat-delivery-child-incomplete",
      }),
    ]);
  });

  it("requires delegated UAT work to stop before trusted admission", async () => {
    const epic = task(14, "uat", { tags: ["type:epic"] });
    const acceptance = task(15, "done", { parent: epic.id, tags: ["uat"] });
    const followUp = task(16, "backlog", {
      lifecycle: "label-replacement",
      parent: epic.id,
      tags: ["type:follow-up"],
    });
    const subject = fixture([epic, acceptance, followUp], {
      coordinated: true,
      trustedTaskIds: [followUp.id],
    });
    subject.instances.instances.push(
      {
        boardStatus: "done",
        instanceId: "task-15",
        state: "done",
        taskId: acceptance.id,
      },
      {
        boardStatus: "done",
        instanceId: "delegated-15",
        parentSessionId: "task-15",
        state: "waiting",
        taskId: acceptance.id,
      },
    );

    await subject.reconciler.reconcile();

    expect(followUp.status).toBe("backlog");
    expect(subject.instances.starts).toEqual([]);
    expect(
      subject.attention.entries.has(
        "epic:14:acceptance:uat-terminal-unverified",
      ),
    ).toBe(true);
  });

  it("completes all dynamic work without starting a second UAT lifecycle", async () => {
    const epic = task(17, "uat", { tags: ["type:epic"] });
    const acceptance = task(18, "done", { parent: epic.id, tags: ["uat"] });
    const followUp = task(19, "done", {
      parent: epic.id,
      tags: ["type:follow-up"],
    });
    const subject = fixture([epic, acceptance, followUp], {
      coordinated: true,
      trustedTaskIds: [followUp.id],
    });
    subject.instances.instances.push(
      {
        boardStatus: "done",
        instanceId: "task-18",
        state: "done",
        taskId: acceptance.id,
      },
      {
        boardStatus: "done",
        instanceId: "task-19",
        state: "done",
        taskId: followUp.id,
      },
    );

    await subject.reconciler.reconcile();

    expect(epic.status).toBe("done");
    expect(subject.board.epicWrites).toEqual([
      { status: "done", taskId: epic.id },
    ]);
    expect(subject.instances.starts).toEqual([]);
  });

  it("does not complete an epic while a dynamic-task intent is pending", async () => {
    const epic = task(20, "uat", { tags: ["type:epic"] });
    const acceptance = task(21, "done", { parent: epic.id, tags: ["uat"] });
    const subject = fixture([epic, acceptance], {
      coordinated: true,
      pendingEpicIds: [epic.id],
    });
    subject.instances.instances.push({
      boardStatus: "done",
      instanceId: "task-21",
      state: "done",
      taskId: acceptance.id,
    });

    await subject.reconciler.reconcile();

    expect(epic.status).toBe("uat");
    expect(subject.board.epicWrites).toEqual([]);
    expect(subject.attention.entries).toHaveLength(0);
  });

  it("lets a Console pause after promotion prevent the start reservation", async () => {
    const operations = new EpicOperationCoordinator();
    const epic = task(22, "uat", { tags: ["type:epic"] });
    const acceptance = task(23, "done", { parent: epic.id, tags: ["uat"] });
    const followUp = task(24, "backlog", {
      lifecycle: "label-replacement",
      parent: epic.id,
      tags: ["type:follow-up"],
    });
    const subject = fixture([epic, acceptance, followUp], {
      coordinated: true,
      epicOperations: operations,
      trustedTaskIds: [followUp.id],
    });
    subject.instances.instances.push({
      boardStatus: "done",
      instanceId: "task-23",
      state: "done",
      taskId: acceptance.id,
    });
    const mirror = subject.board.mirrorTaskStatus.bind(subject.board);
    let pause: Promise<void> | undefined;
    vi.spyOn(subject.board, "mirrorTaskStatus").mockImplementation(
      async (taskId, status) => {
        await mirror(taskId, status);
        if (taskId === followUp.id && status === "todo") {
          pause = operations.run(epic.id, async () => {
            epic.status = "todo";
          });
        }
      },
    );

    await subject.reconciler.reconcile();
    await pause;

    expect(followUp.status).toBe("todo");
    expect(epic.status).toBe("todo");
    expect(subject.instances.starts).toEqual([]);
  });

  it("keeps a start in flight when its durable reservation wins the pause race", async () => {
    const operations = new EpicOperationCoordinator();
    const epic = task(25, "uat", { tags: ["type:epic"] });
    const acceptance = task(26, "done", { parent: epic.id, tags: ["uat"] });
    const followUp = task(27, "todo", {
      lifecycle: "label-replacement",
      parent: epic.id,
      tags: ["type:follow-up"],
    });
    const subject = fixture([epic, acceptance, followUp], {
      coordinated: true,
      epicOperations: operations,
      trustedTaskIds: [followUp.id],
    });
    subject.instances.instances.push({
      boardStatus: "done",
      instanceId: "task-26",
      state: "done",
      taskId: acceptance.id,
    });
    const start = subject.instances.start.bind(subject.instances);
    let pause: Promise<void> | undefined;
    vi.spyOn(subject.instances, "start").mockImplementation(async (input) => {
      await start(input);
      pause = operations.run(epic.id, async () => {
        epic.status = "todo";
      });
    });

    await subject.reconciler.reconcile();
    await pause;

    expect(subject.instances.starts.map(({ task }) => task.id)).toEqual([
      followUp.id,
    ]);
    expect(subject.instances.instances).toContainEqual(
      expect.objectContaining({ taskId: followUp.id, state: "waiting" }),
    );
    expect(epic.status).toBe("todo");
  });

  it("ignites an epic, picks up late children, and dispatches standalone todo tasks", async () => {
    const epic = task(10, "in-progress", { tags: ["type:epic"] });
    const first = task(11, "backlog", {
      lifecycle: "archive-inspection",
      parent: epic.id,
    });
    const standalone = task(20, "todo", {
      lifecycle: "lamp-repair",
    });
    const subject = fixture([epic, first, standalone]);

    const ignition = await subject.reconciler.reconcile();

    expect(subject.board.statusWrites).toEqual([
      { status: "todo", taskId: first.id },
    ]);
    expect(subject.instances.starts.map(({ task }) => task.id)).toEqual([
      first.id,
      standalone.id,
    ]);
    expect(ignition.map(({ kind }) => kind)).toEqual([
      "task-status-transition",
      "instance-start",
      "instance-start",
    ]);

    const late = task(12, "backlog", {
      lifecycle: "label-replacement",
      parent: epic.id,
    });
    subject.board.tasks.push(late);

    await subject.reconciler.reconcile();

    expect(subject.board.statusWrites.at(-1)).toEqual({
      status: "todo",
      taskId: late.id,
    });
    expect(subject.instances.starts.at(-1)?.task.id).toBe(late.id);
    await expect(subject.reconciler.reconcile()).resolves.toEqual([]);
  });

  it("holds dependency-gated work until its dependencies are done", async () => {
    const epic = task(30, "in-progress", { tags: ["type:epic"] });
    const inventory = task(31, "todo", {
      lifecycle: "inventory-count",
      parent: epic.id,
    });
    const display = task(32, "todo", {
      dependencies: [inventory.id],
      lifecycle: "display-preparation",
      parent: epic.id,
    });
    const subject = fixture([epic, inventory, display]);

    await subject.reconciler.reconcile();

    expect(subject.instances.starts.map(({ task }) => task.id)).toEqual([
      inventory.id,
    ]);
    Object.assign(subject.instances.instances[0]!, {
      boardStatus: "done",
      state: "done",
    });

    const released = await subject.reconciler.reconcile();

    expect(subject.board.statusWrites).toContainEqual({
      status: "done",
      taskId: inventory.id,
    });
    expect(subject.instances.starts.map(({ task }) => task.id)).toEqual([
      inventory.id,
      display.id,
    ]);
    expect(released.map(({ kind }) => kind)).toContain("instance-start");
  });

  it("pauses new dispatch after the epic leaves in-progress without stopping an in-flight instance", async () => {
    const epic = task(40, "in-progress", { tags: ["type:epic"] });
    const underway = task(41, "todo", {
      lifecycle: "catalogue-update",
      parent: epic.id,
    });
    const subject = fixture([epic, underway]);
    await subject.reconciler.reconcile();
    const retained = subject.instances.instances[0];
    epic.status = "todo";
    const waiting = task(42, "todo", {
      lifecycle: "shelf-check",
      parent: epic.id,
    });
    subject.board.tasks.push(waiting);

    const actions = await subject.reconciler.reconcile();

    expect(subject.instances.instances[0]).toEqual(retained);
    expect(subject.instances.starts.map(({ task }) => task.id)).toEqual([
      underway.id,
    ]);
    expect(actions).toEqual([]);
  });

  it("projects running and done standalone instances through the board adapter", async () => {
    const standalone = task(45, "todo", { lifecycle: "material-repair" });
    const subject = fixture([standalone]);
    await subject.reconciler.reconcile();
    Object.assign(subject.instances.instances[0]!, {
      boardStatus: "in-progress",
      state: "running",
    });

    await subject.reconciler.reconcile();

    expect(subject.board.statusWrites).toEqual([
      { status: "in-progress", taskId: standalone.id },
    ]);
    Object.assign(subject.instances.instances[0]!, {
      boardStatus: "done",
      state: "done",
    });

    await subject.reconciler.reconcile();

    expect(subject.board.statusWrites.at(-1)).toEqual({
      status: "done",
      taskId: standalone.id,
    });
    expect(standalone.status).toBe("done");
  });

  it("opens UAT after non-UAT children finish and completes the epic after UAT acceptance", async () => {
    const epic = task(50, "in-progress", { tags: ["type:epic"] });
    const delivery = task(51, "done", { parent: epic.id });
    const acceptance = task(52, "backlog", {
      lifecycle: "collection-acceptance",
      parent: epic.id,
      tags: ["uat"],
    });
    const subject = fixture([epic, delivery, acceptance]);

    await subject.reconciler.reconcile();

    expect(subject.board.epicWrites).toEqual([
      { status: "uat", taskId: epic.id },
    ]);
    expect(subject.board.statusWrites).toContainEqual({
      status: "todo",
      taskId: acceptance.id,
    });
    expect(subject.instances.starts.at(-1)?.task.id).toBe(acceptance.id);
    Object.assign(subject.instances.instances[0]!, {
      boardStatus: "done",
      state: "done",
    });
    const lateDelivery = task(53, "backlog", {
      lifecycle: "late-catalogue-repair",
      parent: epic.id,
    });
    subject.board.tasks.push(lateDelivery);

    await subject.reconciler.reconcile();

    expect(subject.board.epicWrites.at(-1)).toEqual({
      status: "uat",
      taskId: epic.id,
    });
    lateDelivery.status = "done";
    await subject.reconciler.reconcile();

    expect(subject.board.epicWrites.at(-1)).toEqual({
      status: "done",
      taskId: epic.id,
    });
  });

  it("keeps acceptance blocked, raises one stable attention, and continues after a UAT child is added", async () => {
    const epic = task(54, "in-progress", { tags: ["type:epic"] });
    const delivery = task(55, "done", { parent: epic.id });
    const subject = fixture([epic, delivery]);

    await subject.reconciler.reconcile();
    await subject.reconciler.reconcile();

    expect(epic.status).toBe("uat");
    expect(subject.board.epicWrites).toEqual([
      { status: "uat", taskId: epic.id },
    ]);
    expect([...subject.attention.entries.values()]).toEqual([
      {
        attentionId: "epic:54:acceptance:uat-child-missing",
        code: "uat-child-missing",
        kind: "epic-acceptance",
        message: "Epic 54 requires a UAT child before acceptance",
        taskId: epic.id,
      },
    ]);

    const acceptance = task(56, "backlog", {
      lifecycle: "room-inspection",
      parent: epic.id,
      tags: ["uat"],
    });
    subject.board.tasks.push(acceptance);

    await subject.reconciler.reconcile();
    await subject.reconciler.reconcile();

    expect(acceptance.status).toBe("todo");
    expect(subject.instances.starts.at(-1)?.task.id).toBe(acceptance.id);
    expect(subject.board.epicWrites).toHaveLength(1);
    expect(subject.attention.entries).toHaveLength(0);
    await expect(
      subject.attention.has("epic:54:acceptance:uat-child-missing"),
    ).resolves.toBe(true);
    expect(subject.attention.resolutions).toEqual([
      "epic:54:acceptance:uat-child-missing",
    ]);
    expect(subject.board.tasks.map(({ id }) => id)).toEqual([54, 55, 56]);

    subject.board.tasks.splice(subject.board.tasks.indexOf(acceptance), 1);
    await subject.reconciler.reconcile();

    expect([...subject.attention.entries.values()]).toEqual([
      expect.objectContaining({
        attentionId: "epic:54:acceptance:uat-child-missing",
      }),
    ]);
    expect(subject.attention.reopenings).toEqual([
      "epic:54:acceptance:uat-child-missing",
    ]);
  });

  it("surfaces incomplete delivery work during UAT until the operator changes the condition", async () => {
    const epic = task(60, "uat", { tags: ["type:epic"] });
    const delivered = task(61, "done", { parent: epic.id });
    const acceptance = task(62, "done", {
      parent: epic.id,
      tags: ["uat"],
    });
    const lateDelivery = task(63, "backlog", {
      lifecycle: "catalogue-repair",
      parent: epic.id,
    });
    const subject = fixture([epic, delivered, acceptance, lateDelivery]);
    const attentionId = "epic:60:acceptance:delivery-child-incomplete";
    const unrelatedAttentionId = "production:unrelated-recovery-probe:task:60";
    await subject.attention.raise({
      attentionId: unrelatedAttentionId,
      code: "unrelated-recovery-probe",
      kind: "production-error",
      message: "Synthetic unrelated condition",
      taskId: epic.id,
    });

    await subject.reconciler.reconcile();
    await subject.reconciler.reconcile();

    expect([...subject.attention.entries.values()]).toEqual([
      expect.objectContaining({ attentionId: unrelatedAttentionId }),
      {
        attentionId,
        code: "uat-delivery-child-incomplete",
        kind: "epic-acceptance",
        message:
          "Epic 60 has incomplete delivery children during UAT; move the epic to in-progress to admit them, or remove or re-parent them",
        taskId: epic.id,
      },
    ]);
    expect(subject.board.epicWrites).toEqual([]);
    expect(subject.board.statusWrites).toEqual([]);
    expect(subject.instances.starts).toEqual([]);
    expect(lateDelivery.status).toBe("backlog");

    expect(subject.attention.resolve(attentionId)).toBe(true);
    await subject.reconciler.reconcile();

    expect(subject.attention.reopenings).toEqual([attentionId]);

    epic.status = "in-progress";
    await subject.reconciler.reconcile();

    expect(lateDelivery.status).toBe("todo");
    expect(subject.instances.starts.at(-1)?.task.id).toBe(lateDelivery.id);
    expect(subject.attention.entries.has(attentionId)).toBe(false);
    expect(subject.attention.entries.has(unrelatedAttentionId)).toBe(true);
    expect(subject.board.epicWrites).toEqual([]);
  });

  it("resolves and reopens the same UAT delivery attention as children finish and recur", async () => {
    const epic = task(64, "uat", { tags: ["type:epic"] });
    const delivery = task(65, "todo", { parent: epic.id });
    const acceptance = task(66, "done", {
      parent: epic.id,
      tags: ["uat"],
    });
    const subject = fixture([epic, delivery, acceptance]);
    const attentionId = "epic:64:acceptance:delivery-child-incomplete";

    await subject.reconciler.reconcile();
    delivery.status = "done";
    await subject.reconciler.reconcile();

    expect(subject.attention.entries.has(attentionId)).toBe(false);
    expect(subject.attention.resolutions).toEqual([attentionId]);
    expect(subject.board.epicWrites).toEqual([
      { status: "done", taskId: epic.id },
    ]);

    epic.status = "uat";
    delivery.status = "todo";
    await subject.reconciler.reconcile();

    expect(subject.attention.entries.has(attentionId)).toBe(true);
    expect(subject.attention.reopenings).toEqual([attentionId]);
  });

  it("does not promote or dispatch blocked child and standalone tasks", async () => {
    const epic = task(55, "in-progress", { tags: ["type:epic"] });
    const child = task(56, "backlog", {
      blocked: true,
      lifecycle: "crate-repair",
      parent: epic.id,
    });
    const standalone = task(57, "todo", {
      blocked: true,
      lifecycle: "window-cleaning",
    });
    const todoChild = task(59, "todo", {
      blocked: true,
      lifecycle: "shelf-cleaning",
      parent: epic.id,
    });
    const subject = fixture([epic, child, standalone, todoChild]);

    await expect(subject.reconciler.reconcile()).resolves.toEqual([]);

    expect(subject.board.statusWrites).toEqual([]);
    expect(subject.instances.starts).toEqual([]);
    expect(child.status).toBe("backlog");
  });

  it("treats an absent dependency record as satisfied", async () => {
    const standalone = task(58, "todo", {
      dependencies: [999],
      lifecycle: "room-inspection",
    });
    const subject = fixture([standalone]);

    await subject.reconciler.reconcile();

    expect(subject.instances.starts.map(({ task }) => task.id)).toEqual([
      standalone.id,
    ]);
  });

  it("raises one attention entry instead of guessing a missing lifecycle", async () => {
    const epic = task(60, "in-progress", { tags: ["type:epic"] });
    const unclassified = task(61, "backlog", { parent: epic.id });
    const subject = fixture([epic, unclassified]);

    const actions = await subject.reconciler.reconcile();

    expect(subject.instances.starts).toEqual([]);
    expect([...subject.attention.entries.values()]).toEqual([
      expect.objectContaining({
        code: "lifecycle-not-declared",
        kind: "lifecycle-resolution",
        taskId: unclassified.id,
      }),
    ]);
    expect(actions.map(({ kind }) => kind)).toEqual([
      "task-status-transition",
      "attention-raised",
    ]);
    await expect(subject.reconciler.reconcile()).resolves.toEqual([]);
  });

  it("raises one attention entry when an instance exceeds its stage threshold", async () => {
    const standalone = task(70, "in-progress", {
      lifecycle: "index-refresh",
    });
    const subject = fixture([standalone], {
      now: () => 50_000,
      staleThresholds: { inspect: 10_000 },
    });
    subject.instances.instances.push({
      boardStatus: "in-progress",
      instanceId: "task-70",
      stageEnteredAt: 30_000,
      stageId: "inspect",
      state: "waiting",
      taskId: standalone.id,
    });

    const actions = await subject.reconciler.reconcile();

    expect(actions).toEqual([
      expect.objectContaining({
        attention: expect.objectContaining({
          kind: "stale-instance",
          taskId: standalone.id,
        }),
        kind: "attention-raised",
      }),
    ]);
    await expect(subject.reconciler.reconcile()).resolves.toEqual([]);
  });

  it("does not infer a staleness deadline for an unconfigured stage", async () => {
    const standalone = task(71, "in-progress", {
      lifecycle: "index-refresh",
    });
    const subject = fixture([standalone], {
      now: () => 50_000,
      staleThresholds: {},
    });
    subject.instances.instances.push({
      boardStatus: "in-progress",
      instanceId: "task-71",
      stageEnteredAt: 0,
      stageId: "inspect",
      state: "waiting",
      taskId: standalone.id,
    });

    await expect(subject.reconciler.reconcile()).resolves.toEqual([]);
    expect(subject.attention.entries).toEqual(new Map());
  });

  it("preserves ready work as a visible deferral until WIP capacity is freed", async () => {
    const underway = task(80, "in-progress", {
      lifecycle: "inventory-count",
    });
    const ready = task(81, "todo", { lifecycle: "label-replacement" });
    const subject = fixture([underway, ready], {
      pacing: pacing({ used: 0, windowStartedAt: 1_000 }),
    });
    subject.instances.instances.push({
      boardStatus: "in-progress",
      depth: 0,
      instanceId: "task-80",
      provider: "provider-a",
      state: "running",
      taskId: underway.id,
    });

    const deferred = await subject.reconciler.reconcile();

    expect(ready.status).toBe("todo");
    expect(subject.instances.instances).toContainEqual({
      boardStatus: "todo",
      deferral: {
        activeSessions: 1,
        limit: 1,
        reason: "work-in-progress-limit",
      },
      depth: 0,
      instanceId: "task-81",
      provider: "provider-a",
      state: "deferred",
      taskId: ready.id,
    });
    expect(deferred).toContainEqual(
      expect.objectContaining({
        deferral: expect.objectContaining({
          reason: "work-in-progress-limit",
        }),
        kind: "dispatch-deferred",
        taskId: ready.id,
      }),
    );

    Object.assign(subject.instances.instances[0]!, {
      boardStatus: "done",
      state: "done",
    });
    const dispatched = await subject.reconciler.reconcile();

    expect(subject.instances.starts.map(({ task }) => task.id)).toEqual([
      ready.id,
    ]);
    expect(subject.instances.starts[0]?.dispatch).toEqual({
      depth: 0,
      provider: "provider-a",
    });
    expect(subject.instances.instances.at(-1)).toMatchObject({
      instanceId: "task-81",
      state: "waiting",
    });
    expect(dispatched).toContainEqual(
      expect.objectContaining({ kind: "instance-start", taskId: ready.id }),
    );
  });

  it("counts starting parent and delegated child sessions against WIP", async () => {
    const starting = task(82, "in-progress", { lifecycle: "inventory-count" });
    const ready = task(83, "todo", { lifecycle: "label-replacement" });
    const subject = fixture([starting, ready], {
      pacing: pacing({ used: 0, windowStartedAt: 1_000 }, () => 2_000, 2),
    });
    subject.instances.instances.push(
      {
        boardStatus: "in-progress",
        depth: 0,
        instanceId: "task-82",
        provider: "provider-a",
        state: "starting",
        taskId: starting.id,
      },
      {
        boardStatus: "in-progress",
        depth: 1,
        instanceId: "delegated-82",
        parentSessionId: "task-82",
        provider: "provider-a",
        state: "waiting",
        taskId: starting.id,
      },
    );

    await subject.reconciler.reconcile();

    expect(subject.instances.starts).toEqual([]);
    expect(subject.instances.instances).toContainEqual(
      expect.objectContaining({
        deferral: {
          activeSessions: 2,
          limit: 2,
          reason: "work-in-progress-limit",
        },
        taskId: ready.id,
      }),
    );
  });

  it("persists a provider-window deferral and dispatches on a later pass", async () => {
    const ready = task(90, "todo", { lifecycle: "surface-cleaning" });
    const usage = { used: 80, windowStartedAt: 10_000 };
    let now = 11_000;
    const subject = fixture([ready], {
      pacing: pacing(usage, () => now),
    });

    await subject.reconciler.reconcile();

    expect(subject.instances.instances).toEqual([
      expect.objectContaining({
        deferral: expect.objectContaining({
          provider: "provider-a",
          reason: "provider-usage-window",
          retryAt: 18_010_000,
        }),
        state: "deferred",
        taskId: ready.id,
      }),
    ]);
    await expect(subject.reconciler.reconcile()).resolves.toEqual([]);
    expect(subject.instances.deferrals).toHaveLength(1);

    now = 18_010_000;
    await subject.reconciler.reconcile();

    expect(subject.instances.starts.map(({ task }) => task.id)).toEqual([
      ready.id,
    ]);
    expect(ready.status).toBe("todo");
  });

  it("reserves WIP capacity between ready tasks in one reconciliation pass", async () => {
    const first = task(100, "todo", { lifecycle: "surface-cleaning" });
    const second = task(101, "todo", { lifecycle: "label-replacement" });
    const subject = fixture([first, second], {
      pacing: pacing({ used: 0, windowStartedAt: 1_000 }),
    });

    await subject.reconciler.reconcile();

    expect(subject.instances.starts.map(({ task }) => task.id)).toEqual([
      first.id,
    ]);
    expect(subject.instances.instances).toContainEqual(
      expect.objectContaining({
        deferral: expect.objectContaining({
          reason: "work-in-progress-limit",
        }),
        state: "deferred",
        taskId: second.id,
      }),
    );

    await subject.reconciler.reconcile();

    expect(subject.instances.starts.map(({ task }) => task.id)).toEqual([
      first.id,
    ]);
    expect(subject.instances.deferrals).toHaveLength(1);
  });

  it("isolates a task start failure and dispatches later ready work", async () => {
    const failing = task(110, "todo", { lifecycle: "surface-cleaning" });
    const later = task(111, "todo", { lifecycle: "label-replacement" });
    const subject = fixture([failing, later], {
      failingStartTaskId: failing.id,
    });

    const actions = await subject.reconciler.reconcile();

    expect(subject.instances.starts.map(({ task }) => task.id)).toEqual([
      later.id,
    ]);
    expect([...subject.attention.entries.values()]).toContainEqual(
      expect.objectContaining({
        attentionId: `production:task-reconciliation-failed:task:${failing.id}`,
        code: "task-reconciliation-failed",
        error: expect.objectContaining({
          message: `Injected start failure for task ${failing.id}`,
        }),
        kind: "production-error",
        taskId: failing.id,
      }),
    );
    expect(actions.map(({ kind }) => kind)).toEqual([
      "attention-raised",
      "instance-start",
    ]);

    await subject.reconciler.reconcile();

    expect(subject.attention.entries).toHaveLength(1);
  });
});
