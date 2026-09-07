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
  deferredTask,
  projection,
  providerDeferredTask,
  response,
  rootTask,
} from "./page-client.test-support.js";

describe("console client request ownership", () => {
  it.each([
    ["backlog", "Start epic →"],
    ["todo", "Start epic →"],
    ["in-progress", "Pause epic ∥"],
    ["uat", "Pause epic ∥"],
    ["done", undefined],
    ["unexpected", undefined],
  ])("renders the safe epic control for %s", async (status, label) => {
    const harness = await clientHarness([{ ...rootTask, status }]);

    expect(
      harness
        .elementsByClass("epic-lever")
        .map(({ textContent }) => textContent),
    ).toEqual(label === undefined ? [] : [label]);
  });

  it("scrolls board and dependency overflow with keyboard-only controls", async () => {
    const harness = await clientHarness();

    for (const viewport of [harness.board, harness.graphViewport]) {
      const preventDefault = vi.fn();
      viewport.dispatch("keydown", { key: "ArrowRight", preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(viewport.scrollLeft).toBe(224);

      viewport.dispatch("keydown", { key: "End", preventDefault });
      expect(viewport.scrollLeft).toBe(viewport.scrollWidth);

      viewport.dispatch("keydown", { key: "Home", preventDefault });
      expect(viewport.scrollLeft).toBe(0);
    }
  });

  it("advances every scheduled lifecycle tail from the preceding nonzero cursor without reloading", async () => {
    const lifecycle = (
      events: Array<{ sequence: number }>,
      nextSequence: number,
    ) => ({
      blueprint: {
        blobHash: "a".repeat(40),
        edges: [],
        id: "example-process",
        nodes: [{ id: "step-a", uses: "wait" }],
        path: "blueprints/example-process.json",
      },
      currentStageIds: ["step-a"],
      events: events.map(({ sequence }) => ({
        executionId: "execution-a",
        payload: { nodeId: "step-a" },
        sequence,
        type: "node:start",
      })),
      instanceId: "instance-11",
      nextSequence,
      status: "awaiting",
      taskId: 11,
    });
    const harness = await clientHarness(
      [rootTask, childTask],
      "http://console.test/?view=lifecycle&task=11&scope=all",
      undefined,
      lifecycle([{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }], 3),
    );
    await vi.waitFor(() => expect(harness.lifecycleSnapshots).toHaveLength(1));

    harness.queueLifecycle(lifecycle([{ sequence: 4 }], 4));
    harness.queueLifecycle(lifecycle([{ sequence: 5 }], 5));
    harness.runNextTimeout();

    await vi.waitFor(() => expect(harness.lifecycleSnapshots).toHaveLength(2));
    harness.runNextTimeout();
    await vi.waitFor(() => expect(harness.lifecycleSnapshots).toHaveLength(3));

    expect(harness.lifecycleRequests).toEqual([
      "/api/lifecycle?task=11&after=0",
      "/api/lifecycle?task=11&after=3",
      "/api/lifecycle?task=11&after=4",
    ]);
    expect(harness.lifecycleSnapshots).toMatchObject([
      {
        events: [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }],
        nextSequence: 3,
      },
      { events: [{ sequence: 4 }], nextSequence: 4 },
      { events: [{ sequence: 5 }], nextSequence: 5 },
    ]);
    expect(harness.location()).toBe(
      "http://console.test/?view=lifecycle&task=11&scope=all",
    );
    expect(harness.status.textContent).toBe(
      "Lifecycle live · 5 ordered events",
    );
  });

  it("renders a visible structured deferral on a ready card", async () => {
    const harness = await clientHarness([rootTask, deferredTask]);

    const readout = harness.elementsByClass("deferral-readout");
    expect(readout).toHaveLength(1);
    expect(readout[0]?.children.map(({ textContent }) => textContent)).toEqual([
      "DEFERRED",
      "2 / 2 active sessions",
    ]);
    expect(harness.cardIds()).toEqual(["10", "11"]);
  });

  it("renders the provider window reopen time", async () => {
    const harness = await clientHarness([rootTask, providerDeferredTask]);

    const readout = harness.elementsByClass("deferral-readout");
    expect(readout[0]?.children.map(({ textContent }) => textContent)).toEqual([
      "DEFERRED",
      "provider-a 80 / 80 until 1970-01-01T05:00:10.000Z",
    ]);
  });

  it("ignores a stale successful scope load after a newer failure", async () => {
    const harness = await clientHarness();
    const heldSuccess = deferred<BrowserResponse>();
    harness.holdProjection("epic:10", heldSuccess.promise);

    harness.navigate("epic:10");
    harness.navigate("epic:999");
    await vi.waitFor(() => expect(harness.status.dataset.error).toBe("true"));
    expect(harness.scope.selectedIndex).toBe(-1);
    expect(harness.cardIds()).toEqual([]);

    heldSuccess.resolve(response(projection([childTask])));
    await delay(0);

    expect(harness.status.dataset.error).toBe("true");
    expect(harness.scope.selectedIndex).toBe(-1);
    expect(harness.cardIds()).toEqual([]);
  });

  it("ignores a stale failed scope load after a newer success", async () => {
    const harness = await clientHarness();
    const heldFailure = deferred<BrowserResponse>();
    harness.holdProjection("epic:999", heldFailure.promise);

    harness.navigate("epic:999");
    harness.navigate("epic:10");
    await vi.waitFor(() =>
      expect(harness.status.textContent).toBe("2 visible records"),
    );
    expect(harness.scope.value).toBe("epic:10");
    expect(harness.cardIds()).toEqual(["10", "11"]);

    heldFailure.resolve(
      response("scope epic:999 is invalid", { ok: false, status: 400 }),
    );
    await delay(0);

    expect(harness.status.dataset.error).toBe("false");
    expect(harness.scope.value).toBe("epic:10");
    expect(harness.cardIds()).toEqual(["10", "11"]);
  });
});
