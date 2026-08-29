// ---
// relationships:
//   implements: heddle
// ---

import { describe, expect, it } from "vitest";

import type { BoardTask } from "../board-adapter/index.js";
import {
  Reconciler,
  type ReconcilerAttention,
  type ReconcilerBoard,
  type ReconcilerInstance,
  type ReconcilerInstanceController,
  type ReconcilerLifecycleResolver,
} from "./index.js";

const task = (
  id: number,
  status: string,
  overrides: Partial<BoardTask> = {},
): BoardTask => ({
  dependencies: [],
  id,
  priority: "medium",
  status,
  tags: [],
  title: `Sample record ${id}`,
  ...overrides,
});

class FixtureBoard implements ReconcilerBoard {
  readonly childWrites: Array<{ status: string; taskId: number }> = [];
  readonly epicWrites: Array<{ status: "done" | "uat"; taskId: number }> = [];

  constructor(readonly tasks: BoardTask[]) {}

  async readBoard(): Promise<BoardTask[]> {
    return this.tasks.map((item) => ({ ...item }));
  }

  async mirrorChildStatus(taskId: number, status: string): Promise<void> {
    const item = this.required(taskId);
    if (item.parent === undefined) throw new Error("fixture expected a child");
    item.status = status;
    this.childWrites.push({ status, taskId });
  }

  async transitionEpicStatus(
    taskId: number,
    status: "done" | "uat",
  ): Promise<void> {
    this.required(taskId).status = status;
    this.epicWrites.push({ status, taskId });
  }

  private required(taskId: number): BoardTask {
    const item = this.tasks.find(({ id }) => id === taskId);
    if (item === undefined) throw new Error(`fixture task ${taskId} is absent`);
    return item;
  }
}

class FixtureInstances implements ReconcilerInstanceController {
  readonly instances: ReconcilerInstance[] = [];
  readonly starts: Array<{
    blueprintPath: string;
    instanceId: string;
    task: BoardTask;
  }> = [];

  async listInstances(): Promise<ReconcilerInstance[]> {
    return this.instances.map((instance) => ({ ...instance }));
  }

  async start(input: {
    blueprintPath: string;
    instanceId: string;
    task: BoardTask;
  }): Promise<void> {
    this.starts.push(input);
    this.instances.push({
      boardStatus: input.task.status,
      instanceId: input.instanceId,
      state: "waiting",
      taskId: input.task.id,
    });
  }
}

class FixtureAttentionQueue {
  readonly entries = new Map<string, ReconcilerAttention>();

  async has(attentionId: string): Promise<boolean> {
    return this.entries.has(attentionId);
  }

  async raise(attention: ReconcilerAttention): Promise<void> {
    this.entries.set(attention.attentionId, attention);
  }
}

const lifecycleResolver: ReconcilerLifecycleResolver = {
  resolve: async (item) =>
    item.lifecycle === undefined
      ? {
          attention: {
            code: "lifecycle-not-declared",
            message: `Task ${item.id} does not declare a lifecycle`,
            taskId: item.id,
          },
          kind: "attention-required",
        }
      : {
          artifactId: item.lifecycle,
          blueprintPath: `blueprints/${item.lifecycle}.json`,
          kind: "resolved",
        },
};

const fixture = (
  tasks: BoardTask[],
  options: {
    now?: () => number;
    staleThresholds?: Record<string, number>;
  } = {},
) => {
  const board = new FixtureBoard(tasks);
  const instances = new FixtureInstances();
  const attention = new FixtureAttentionQueue();
  const reconciler = new Reconciler({
    attention,
    board,
    instances,
    lifecycleResolver,
    ...options,
  });
  return { attention, board, instances, reconciler };
};

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

    expect(subject.board.childWrites).toEqual([
      { status: "todo", taskId: first.id },
    ]);
    expect(subject.instances.starts.map(({ task }) => task.id)).toEqual([
      first.id,
      standalone.id,
    ]);
    expect(ignition.map(({ kind }) => kind)).toEqual([
      "child-status-transition",
      "instance-start",
      "instance-start",
    ]);

    const late = task(12, "backlog", {
      lifecycle: "label-replacement",
      parent: epic.id,
    });
    subject.board.tasks.push(late);

    await subject.reconciler.reconcile();

    expect(subject.board.childWrites.at(-1)).toEqual({
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

    expect(subject.board.childWrites).toContainEqual({
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
    expect(subject.board.childWrites).toContainEqual({
      status: "todo",
      taskId: acceptance.id,
    });
    expect(subject.instances.starts.at(-1)?.task.id).toBe(acceptance.id);
    Object.assign(subject.instances.instances[0]!, {
      boardStatus: "done",
      state: "done",
    });

    await subject.reconciler.reconcile();

    expect(subject.board.epicWrites.at(-1)).toEqual({
      status: "done",
      taskId: epic.id,
    });
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
      "child-status-transition",
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
