import { describe, expect, it } from "vitest";

import type { BoardTask } from "../board-adapter/index.js";
import {
  buildKanbanProjection,
  parseConsoleScope,
  serializeConsoleScope,
} from "./projection.js";

const boardTask = (
  id: number,
  title: string,
  status: string,
  overrides: Partial<BoardTask> = {},
): BoardTask => ({
  blocked: false,
  dependencies: [],
  id,
  priority: "medium",
  status,
  tags: [],
  title,
  ...overrides,
});

describe("kanban console projection", () => {
  const tasks = [
    boardTask(41, "Seasonal display", "in-progress", {
      tags: ["type:epic"],
    }),
    boardTask(42, "Count storage crates", "in-progress", { parent: 41 }),
    boardTask(43, "Prepare shelf labels", "todo", { parent: 41 }),
    boardTask(90, "Repair reading-room lamp", "done"),
  ];

  it("enriches only in-progress cards with lifecycle stage and dwell", () => {
    const projection = buildKanbanProjection({
      instances: [
        {
          instanceId: "instance-42",
          stageEnteredAt: 1_000,
          stageId: "inspect",
          taskId: 42,
        },
        {
          instanceId: "instance-90",
          stageEnteredAt: 200_000,
          stageId: "archive",
          taskId: 90,
        },
      ],
      now: 121_000,
      scope: { kind: "all" },
      statuses: ["todo", "in-progress", "done"],
      tasks,
    });

    expect(projection.columns.map(({ status }) => status)).toEqual([
      "todo",
      "in-progress",
      "done",
    ]);
    expect(projection.columns[1]?.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dwellMilliseconds: 120_000,
          instanceId: "instance-42",
          stageId: "inspect",
          title: "Count storage crates",
        }),
      ]),
    );
    expect(projection.columns[2]?.tasks[0]).not.toHaveProperty("stageId");

    const futureStage = buildKanbanProjection({
      instances: [
        {
          instanceId: "instance-42",
          stageEnteredAt: 200_000,
          stageId: "inspect",
          taskId: 42,
        },
      ],
      now: 121_000,
      scope: { kind: "task", taskId: 42 },
      statuses: ["todo", "in-progress", "done"],
      tasks,
    });
    expect(futureStage.columns[1]?.tasks[0]).toMatchObject({
      dwellMilliseconds: 0,
    });
  });

  it("filters all, epic, and task scopes without changing board columns", () => {
    const project = (scope: ReturnType<typeof parseConsoleScope>) =>
      buildKanbanProjection({
        instances: [],
        now: 0,
        scope,
        statuses: ["todo", "in-progress", "done"],
        tasks,
      });
    const ids = (scope: ReturnType<typeof parseConsoleScope>) =>
      project(scope).columns.flatMap(({ tasks: items }) =>
        items.map(({ id }) => id),
      );

    expect(ids(parseConsoleScope("all"))).toEqual([43, 41, 42, 90]);
    expect(ids(parseConsoleScope("epic:41"))).toEqual([43, 41, 42]);
    expect(ids(parseConsoleScope("task:42"))).toEqual([42]);
    expect(serializeConsoleScope(parseConsoleScope("epic:41"))).toBe("epic:41");
    expect(() => parseConsoleScope("epic:0")).toThrow(
      "scope must be all, epic:<id>, or task:<id>",
    );
    expect(() => parseConsoleScope("task:99999999999999999")).toThrow(
      "scope id must be a safe integer",
    );
  });

  it("rejects agreements that would silently hide cards or instances", () => {
    expect(() =>
      buildKanbanProjection({
        instances: [],
        now: 0,
        scope: { kind: "all" },
        statuses: ["todo"],
        tasks,
      }),
    ).toThrow("uses unconfigured board status");
    expect(() =>
      buildKanbanProjection({
        instances: [
          { instanceId: "instance-a", taskId: 42 },
          { instanceId: "instance-b", taskId: 42 },
        ],
        now: 0,
        scope: { kind: "all" },
        statuses: ["todo", "in-progress", "done"],
        tasks,
      }),
    ).toThrow("more than one instance exists for task 42");
  });
});
