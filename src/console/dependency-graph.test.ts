// ---
// relationships:
//   validates: heddle
// ---

import { describe, expect, it } from "vitest";

import type { BoardTask } from "../board-adapter/index.js";
import { buildDependencyGraphProjection } from "./dependency-graph.js";

const task = (
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

describe("dependency graph projection", () => {
  const tasks = [
    task(10, "Example collection", "in-progress", { tags: ["type:epic"] }),
    task(11, "Locate storage list", "in-progress", { parent: 10 }),
    task(12, "Count storage crates", "todo", {
      dependencies: [11],
      parent: 10,
    }),
    task(13, "Prepare shelf labels", "todo", {
      dependencies: [12],
      parent: 10,
    }),
    task(14, "Publish inventory", "done", {
      dependencies: [13],
      parent: 10,
    }),
    task(80, "Repair reading-room lamp", "todo"),
  ];

  it("renders the four treatments and traces a blocked chain from attention", () => {
    const graph = buildDependencyGraphProjection({
      attention: [
        {
          attentionId: "attention-11",
          instanceId: "instance-11",
          kind: "stale-instance",
          message: "Inspection is required",
        },
      ],
      instances: [{ instanceId: "instance-11", taskId: 11 }],
      scope: { epicId: 10, kind: "epic" },
      tasks,
    });

    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 10, treatment: "running" }),
        expect.objectContaining({ id: 11, layer: 0, treatment: "attention" }),
        expect.objectContaining({ id: 12, layer: 1, treatment: "blocked" }),
        expect.objectContaining({ id: 13, layer: 2, treatment: "blocked" }),
        expect.objectContaining({ id: 14, layer: 3, treatment: "done" }),
      ]),
    );
    expect(graph.edges).toEqual([
      { from: 11, to: 12, trace: true },
      { from: 12, to: 13, trace: true },
      { from: 13, to: 14, trace: false },
    ]);
  });

  it("uses the same all, epic, and task scope agreement as the board", () => {
    const ids = (
      scope: Parameters<typeof buildDependencyGraphProjection>[0]["scope"],
    ) =>
      buildDependencyGraphProjection({
        attention: [],
        instances: [],
        scope,
        tasks,
      }).nodes.map(({ id }) => id);

    expect(ids({ kind: "all" })).toEqual([10, 11, 12, 13, 14, 80]);
    expect(ids({ epicId: 10, kind: "epic" })).toEqual([10, 11, 12, 13, 14]);
    expect(ids({ kind: "task", taskId: 12 })).toEqual([12]);
    expect(() => ids({ epicId: 11, kind: "epic" })).toThrow(
      "epic scope 11 must name a root type:epic task",
    );
  });

  it("rejects identity disagreement and cyclic visible dependencies", () => {
    expect(() =>
      buildDependencyGraphProjection({
        attention: [
          {
            attentionId: "attention-11",
            instanceId: "instance-11",
            kind: "stale-instance",
            message: "Inspection is required",
            taskId: 12,
          },
        ],
        instances: [{ instanceId: "instance-11", taskId: 11 }],
        scope: { kind: "all" },
        tasks,
      }),
    ).toThrow("attention attention-11 disagrees about its task identity");

    expect(() =>
      buildDependencyGraphProjection({
        attention: [],
        instances: [],
        scope: { kind: "all" },
        tasks: [
          task(21, "First", "todo", { dependencies: [22] }),
          task(22, "Second", "todo", { dependencies: [21] }),
        ],
      }),
    ).toThrow("dependency graph contains a cycle");
  });
});
