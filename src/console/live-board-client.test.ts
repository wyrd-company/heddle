// ---
// relationships:
//   validates: heddle
// ---

import { describe, expect, it, vi } from "vitest";

import {
  type BrowserResponse,
  childTask,
  clientHarness,
  deferred,
  rootTask,
} from "./page-client.test-support.js";

const refreshedTask = {
  blocked: false,
  dependencies: [],
  id: 12,
  parent: 10,
  priority: "medium",
  status: "done",
  tags: [],
  title: "Complete the updated item",
};

const refreshedGraph = {
  edges: [
    { from: 10, to: 11, trace: true },
    { from: 11, to: 12, trace: false },
  ],
  nodes: [
    {
      id: 10,
      layer: 0,
      priority: "medium",
      row: 0,
      status: "in-progress",
      title: "Example group",
      treatment: "running",
    },
    {
      id: 11,
      layer: 1,
      priority: "medium",
      row: 0,
      status: "in-progress",
      title: "Example item",
      treatment: "running",
    },
    {
      id: 12,
      layer: 2,
      priority: "medium",
      row: 0,
      status: "done",
      title: "Complete the updated item",
      treatment: "done",
    },
  ],
};

describe("console live board polling", () => {
  it("updates the scoped board without navigation or scroll reset", async () => {
    const harness = await clientHarness(
      [rootTask, childTask],
      "http://console.test/?scope=epic%3A10",
    );
    harness.board.scrollLeft = 224;
    harness.replaceTasks([rootTask, childTask, refreshedTask]);

    harness.runNextTimeout();

    await vi.waitFor(() =>
      expect(harness.cardIds()).toEqual(["10", "11", "12"]),
    );
    expect(harness.location()).toBe("http://console.test/?scope=epic%3A10");
    expect(harness.scope.value).toBe("epic:10");
    expect(harness.board.scrollLeft).toBe(224);
    expect(harness.liveBoardStatus.textContent).toBe("LIVE BOARD");
    expect(harness.liveBoardMark.dataset.health).toBe("live");
  });

  it("updates the scoped dependency graph without navigation or scroll reset", async () => {
    const harness = await clientHarness(
      [rootTask, childTask],
      "http://console.test/?view=dependencies&scope=epic%3A10",
    );
    harness.graphViewport.scrollLeft = 224;
    harness.replaceTasks([rootTask, childTask, refreshedTask]);
    harness.replaceGraph(refreshedGraph);

    harness.runNextTimeout();

    await vi.waitFor(() =>
      expect(
        harness.graphCanvas.children
          .filter(({ tagName }) => tagName === "a")
          .map(({ dataset }) => dataset.taskId),
      ).toEqual(["10", "11", "12"]),
    );
    expect(harness.location()).toBe(
      "http://console.test/?view=dependencies&scope=epic%3A10",
    );
    expect(harness.scope.value).toBe("epic:10");
    expect(harness.graphViewport.scrollLeft).toBe(224);
  });

  it("marks the board stale when scheduled updates stop", async () => {
    const harness = await clientHarness();
    const heldBoard = deferred<BrowserResponse>();
    harness.holdBoard(heldBoard.promise);

    harness.runNextTimeout();
    harness.runNextTimeout();

    await vi.waitFor(() =>
      expect(harness.liveBoardStatus.textContent).toBe("BOARD STALE"),
    );
    expect(harness.liveBoardMark.dataset.health).toBe("stale");
  });
});
