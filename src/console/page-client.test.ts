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
    harness.holdProjection("task:11", heldSuccess.promise);

    harness.navigate("task:11");
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
    harness.navigate("task:11");
    await vi.waitFor(() =>
      expect(harness.status.textContent).toBe("1 visible records"),
    );
    expect(harness.scope.value).toBe("task:11");
    expect(harness.cardIds()).toEqual(["11"]);

    heldFailure.resolve(
      response("scope epic:999 is invalid", { ok: false, status: 400 }),
    );
    await delay(0);

    expect(harness.status.dataset.error).toBe("false");
    expect(harness.scope.value).toBe("task:11");
    expect(harness.cardIds()).toEqual(["11"]);
  });
});
