// ---
// relationships:
//   validates: heddle
// ---

import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it, vi } from "vitest";

import { createConsoleAttention } from "./attention-contract.js";
import {
  type BrowserResponse,
  childTask,
  clientHarness,
  deferred,
  projection,
  response,
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

const informationalAttention = (attentionId: string) =>
  createConsoleAttention({
    actions: [],
    attentionId,
    instanceId: "instance-11",
    kind: "stale-work",
    message: "A sample record requires operator attention",
    scope: "task:11",
    taskId: 11,
  });

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

  it("does not let an old live poll overwrite a newer scoped view", async () => {
    const harness = await clientHarness();
    const heldBoard = deferred<BrowserResponse>();
    harness.holdBoard(heldBoard.promise);
    harness.runNextTimeout();
    harness.releaseBoard();

    harness.navigate("task:11");
    await vi.waitFor(() => expect(harness.cardIds()).toEqual(["11"]));
    heldBoard.resolve(response({ tasks: [rootTask, childTask] }));

    await delay(20);
    expect(harness.cardIds()).toEqual(["11"]);
    expect(harness.board.replaceCount).toBe(2);
    expect(harness.scope.value).toBe("task:11");
    expect(harness.projectionRequests).toEqual(["all", "task:11"]);
  });

  it("does not render an old live projection after scope navigation", async () => {
    const harness = await clientHarness();
    const heldProjection = deferred<BrowserResponse>();
    harness.holdProjection("all", heldProjection.promise);
    harness.runNextTimeout();
    await vi.waitFor(() =>
      expect(
        harness.projectionRequests.filter((scope) => scope === "all"),
      ).toHaveLength(2),
    );

    harness.navigate("task:11");
    await vi.waitFor(() => expect(harness.cardIds()).toEqual(["11"]));
    heldProjection.resolve(
      response(projection([rootTask, childTask, refreshedTask])),
    );

    await delay(20);
    expect(harness.cardIds()).toEqual(["11"]);
    expect(harness.board.replaceCount).toBe(2);
    expect(harness.scope.value).toBe("task:11");
  });

  it("does not reopen dismissed linked attention while refreshing its data", async () => {
    const linkedAttention = informationalAttention("attention-11");
    const harness = await clientHarness(
      [rootTask, childTask],
      "http://console.test/?scope=all&attention=attention-11",
      undefined,
      undefined,
      [linkedAttention],
    );
    const linkedEntry = harness
      .attentionElements()
      .find(({ dataset }) => dataset.attentionId === "attention-11")!;
    const initialFocusCount = linkedEntry.focusCount;
    const initialScrollIntoViewCount = linkedEntry.scrollIntoViewCount;
    harness.attentionOverlay.close();
    harness.replaceAttention([
      linkedAttention,
      informationalAttention("attention-12"),
    ]);

    harness.runNextTimeout();

    await vi.waitFor(() => expect(harness.attention.textContent).toBe("2"));
    expect(harness.attentionOverlay.open).toBe(false);
    const refreshedEntry = harness
      .attentionElements()
      .find(({ dataset }) => dataset.attentionId === "attention-11")!;
    expect(refreshedEntry.focusCount).toBe(0);
    expect(refreshedEntry.scrollIntoViewCount).toBe(0);
    expect(initialFocusCount).toBe(1);
    expect(initialScrollIntoViewCount).toBe(1);
  });

  it("does not render an old live dependency graph after scope navigation", async () => {
    const harness = await clientHarness(
      [rootTask, childTask],
      "http://console.test/?view=dependencies&scope=all",
    );
    const heldGraph = deferred<BrowserResponse>();
    harness.holdGraph("all", heldGraph.promise);
    harness.runNextTimeout();
    await vi.waitFor(() =>
      expect(
        harness.graphRequests.filter((scope) => scope === "all"),
      ).toHaveLength(2),
    );

    harness.navigateUrl(
      "http://console.test/?view=dependencies&scope=task%3A11",
    );
    await vi.waitFor(() =>
      expect(
        harness.graphCanvas.children
          .filter(({ tagName }) => tagName === "a")
          .map(({ dataset }) => dataset.taskId),
      ).toEqual(["11"]),
    );
    heldGraph.resolve(response(refreshedGraph));

    await delay(20);
    expect(
      harness.graphCanvas.children
        .filter(({ tagName }) => tagName === "a")
        .map(({ dataset }) => dataset.taskId),
    ).toEqual(["11"]);
    expect(harness.graphCanvas.replaceCount).toBe(2);
    expect(harness.scope.value).toBe("task:11");
  });
});
