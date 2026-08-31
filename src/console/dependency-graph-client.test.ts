// ---
// relationships:
//   validates: heddle
// ---

import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it, vi } from "vitest";

import {
  type BrowserResponse,
  childTask,
  clientHarness,
  deferred,
  response,
  rootTask,
} from "./page-client.test-support.js";

describe("console client request ownership", () => {
  it("renders traced graph nodes with task-scoped lifecycle links", async () => {
    const harness = await clientHarness(
      [rootTask, childTask],
      "http://console.test/?view=dependencies&scope=epic%3A10",
    );

    expect(harness.board.hidden).toBe(true);
    expect(harness.graph.hidden).toBe(false);
    expect(harness.viewEyebrow.textContent).toBe("DEPENDENCY GRAPH");
    expect(harness.status.textContent).toBe(
      "2 visible nodes · 1 dependency edges",
    );
    const links = harness.graphCanvas.children.filter(
      ({ tagName }) => tagName === "a",
    );
    expect(links.map(({ dataset }) => dataset.treatment)).toEqual([
      "attention",
      "blocked",
    ]);
    expect(links[1]?.href).toBe("/?view=lifecycle&scope=task%3A11");
    expect(links[1]?.getAttribute("aria-label")).toContain(
      "Open lifecycle view",
    );
    const edge = harness.graphCanvas.children[0]?.children.find(
      (element) =>
        element.tagName === "path" &&
        element.getAttribute("data-trace") !== null,
    );
    expect(edge?.dataset.trace).toBeUndefined();
    expect(edge?.getAttribute("data-trace")).toBe("true");
    expect(harness.dependenciesViewLink.getAttribute("aria-current")).toBe(
      "page",
    );
    expect(harness.boardViewLink.href).toBe("/?scope=epic%3A10");
    expect(harness.dependenciesViewLink.href).toBe(
      "/?view=dependencies&scope=epic%3A10",
    );
    expect(links.map(({ style }) => [style.left, style.top])).toEqual([
      ["28px", "28px"],
      ["338px", "28px"],
    ]);

    harness.scope.value = "task:11";
    harness.scope.dispatch("change");
    await vi.waitFor(() =>
      expect(harness.status.textContent).toBe(
        "1 visible nodes · 0 dependency edges",
      ),
    );
    expect(harness.location()).toBe(
      "http://console.test/?view=dependencies&scope=task%3A11",
    );
  });

  it("opens the task-scoped lifecycle route selected by a graph node", async () => {
    const harness = await clientHarness(
      [rootTask, childTask],
      "http://console.test/?view=lifecycle&scope=task%3A11",
    );

    expect(harness.lifecycle.hidden).toBe(false);
    expect(harness.lifecycleTask.textContent).toBe("Task #11 · Example item");
    expect(harness.scope.value).toBe("task:11");
    expect(
      harness.scope.options.map(({ textContent }) => textContent),
    ).toContain("Task #11 · Example item");
    expect(harness.status.textContent).toBe("Lifecycle view for task #11");
  });

  it("shows an identified not-yet-started state for an undispatched task", async () => {
    const harness = await clientHarness(
      [rootTask, childTask],
      "http://console.test/?view=lifecycle&scope=task%3A11",
      undefined,
      response(
        {
          code: "lifecycle-not-started",
          error: "Task 11 has no production lifecycle instance",
        },
        { ok: false, status: 404 },
      ),
    );

    expect(harness.lifecycle.hidden).toBe(false);
    expect(harness.lifecycleTask.textContent).toBe("Task #11 · Example item");
    expect(harness.scope.value).toBe("task:11");
    expect(harness.lifecycleEmpty.hidden).toBe(false);
    expect(harness.lifecycleEmpty.textContent).toBe(
      "No lifecycle instance exists for this task. It has not started yet.",
    );
    expect(harness.lifecycleSnapshots).toEqual([]);
    expect(harness.status.dataset.error).toBe("false");
    expect(harness.status.textContent).toBe(
      "Lifecycle has not started for task #11",
    );
    expect(harness.liveBoardStatus.textContent).toBe("BOARD SNAPSHOT");
  });

  it("keeps ordinary long titles in non-overlapping graph rows", async () => {
    const longTitle =
      "Prepare complete shelf labels for all retained inventory records and the supporting archive";
    const harness = await clientHarness(
      [rootTask, { ...childTask, title: longTitle }],
      "http://console.test/?view=dependencies&scope=epic%3A10",
      {
        edges: [],
        nodes: [
          {
            id: 10,
            layer: 0,
            priority: "medium",
            row: 0,
            status: "in-progress",
            title: longTitle,
            treatment: "running",
          },
          {
            id: 11,
            layer: 0,
            priority: "medium",
            row: 1,
            status: "in-progress",
            title: longTitle,
            treatment: "running",
          },
        ],
      },
    );

    const links = harness.graphCanvas.children.filter(
      ({ tagName }) => tagName === "a",
    );
    expect(links.map(({ style }) => style.top)).toEqual(["28px", "184px"]);
    expect(links.map((link) => link.getAttribute("title"))).toEqual([
      longTitle,
      longTitle,
    ]);
    expect(links[1]?.getAttribute("aria-label")).toContain(longTitle);
  });

  it("fails closed for unknown views and non-task lifecycle scopes", async () => {
    const unknownView = await clientHarness(
      [rootTask, childTask],
      "http://console.test/?view=several&scope=all",
    );
    expect(unknownView.status.dataset.error).toBe("true");
    expect(unknownView.status.textContent).toBe(
      "view must be board, dependencies, or lifecycle",
    );

    const invalidLifecycle = await clientHarness(
      [rootTask, childTask],
      "http://console.test/?view=lifecycle&scope=epic%3A10",
    );
    expect(invalidLifecycle.status.dataset.error).toBe("true");
    expect(invalidLifecycle.status.textContent).toBe(
      "lifecycle view requires task:<id> scope",
    );
  });

  it("ignores a stale graph after task lifecycle navigation", async () => {
    const harness = await clientHarness();
    const heldGraph = deferred<BrowserResponse>();
    harness.holdGraph("epic:10", heldGraph.promise);

    harness.navigateUrl(
      "http://console.test/?view=dependencies&scope=epic%3A10",
    );
    await delay(0);
    harness.navigateUrl("http://console.test/?view=lifecycle&scope=task%3A11");
    await vi.waitFor(() =>
      expect(harness.status.textContent).toBe("Lifecycle view for task #11"),
    );

    heldGraph.resolve(response({ edges: [], nodes: [] }));
    await delay(0);

    expect(harness.lifecycle.hidden).toBe(false);
    expect(harness.status.textContent).toBe("Lifecycle view for task #11");
    expect(harness.graphCanvas.children).toEqual([]);
  });
});
