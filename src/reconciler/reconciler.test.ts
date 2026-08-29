// ---
// relationships:
//   implements: heddle
// ---

import { describe, expect, it } from "vitest";

import { fixture, task } from "./reconciler.test-support.js";

describe("Reconciler", () => {
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
});
