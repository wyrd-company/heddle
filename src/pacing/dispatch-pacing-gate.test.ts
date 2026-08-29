// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import { DispatchPacingGate, PROVIDER_USAGE_WINDOW_MS } from "./index.js";
import {
  configuration,
  UsageStub,
} from "./dispatch-pacing-gate.test-support.js";

describe("DispatchPacingGate", () => {
  it("defers at the shared WIP limit and dispatches after capacity is freed", async () => {
    const usage = new UsageStub({
      "provider-a": { used: 10, windowStartedAt: 1_000 },
    });
    const gate = new DispatchPacingGate(configuration(), usage, () => 2_000);
    const request = {
      kind: "task" as const,
      provider: "provider-a",
      sessionId: "session-c",
    };
    const active = [
      { depth: 0, provider: "provider-a", sessionId: "session-a" },
      { depth: 0, provider: "provider-b", sessionId: "session-b" },
    ];

    await expect(gate.evaluate(request, active)).resolves.toEqual({
      deferral: {
        activeSessions: 2,
        limit: 2,
        reason: "work-in-progress-limit",
      },
      kind: "defer",
    });
    expect(usage.reads).toEqual([]);
    await expect(gate.evaluate(request, active.slice(1))).resolves.toEqual({
      kind: "dispatch",
    });
  });

  it("defers exhausted provider usage until the five-hour window opens", async () => {
    const windowStartedAt = 10_000;
    const usage = new UsageStub({
      "provider-a": { used: 80.5, windowStartedAt },
    });
    let now = windowStartedAt + 1;
    const gate = new DispatchPacingGate(
      configuration({
        providerBudgets: { "provider-a": { usageLimit: 80.5 } },
      }),
      usage,
      () => now,
    );
    const request = {
      kind: "task" as const,
      provider: "provider-a",
      sessionId: "session-a",
    };

    await expect(gate.evaluate(request, [])).resolves.toEqual({
      deferral: {
        limit: 80.5,
        provider: "provider-a",
        reason: "provider-usage-window",
        retryAt: windowStartedAt + PROVIDER_USAGE_WINDOW_MS,
        used: 80.5,
      },
      kind: "defer",
    });

    now = windowStartedAt + PROVIDER_USAGE_WINDOW_MS;
    await expect(gate.evaluate(request, [])).resolves.toEqual({
      kind: "dispatch",
    });
    expect(usage.reads).toEqual(["provider-a", "provider-a"]);
  });

  it("enforces subagent depth and fan-out before shared capacity", async () => {
    const usage = new UsageStub({
      "provider-a": { used: 0, windowStartedAt: 1_000 },
    });
    const gate = new DispatchPacingGate(
      configuration({ maxConcurrentSessions: 10 }),
      usage,
      () => 2_000,
    );
    const depthLimited = [
      {
        depth: 2,
        provider: "provider-a",
        sessionId: "parent-a",
      },
    ];

    await expect(
      gate.evaluate(
        {
          kind: "subagent",
          parentSessionId: "parent-a",
          provider: "provider-a",
          sessionId: "child-c",
        },
        depthLimited,
      ),
    ).resolves.toEqual({
      deferral: {
        limit: 2,
        reason: "subagent-depth-limit",
        requestedDepth: 3,
      },
      kind: "defer",
    });

    await expect(
      gate.evaluate(
        {
          kind: "subagent",
          parentSessionId: "parent-a",
          provider: "provider-a",
          sessionId: "child-c",
        },
        [
          {
            depth: 1,
            provider: "provider-a",
            sessionId: "parent-a",
          },
        ],
      ),
    ).resolves.toEqual({ kind: "dispatch" });

    const active = [
      {
        depth: 0,
        provider: "provider-a",
        sessionId: "parent-a",
      },
      {
        depth: 1,
        parentSessionId: "parent-a",
        provider: "provider-a",
        sessionId: "child-a",
      },
      {
        depth: 1,
        parentSessionId: "parent-a",
        provider: "provider-a",
        sessionId: "child-b",
      },
    ];

    await expect(
      gate.evaluate(
        {
          kind: "subagent",
          parentSessionId: "parent-a",
          provider: "provider-a",
          sessionId: "child-c",
        },
        active,
      ),
    ).resolves.toEqual({
      deferral: {
        activeChildren: 2,
        limit: 2,
        parentSessionId: "parent-a",
        reason: "subagent-fan-out-limit",
      },
      kind: "defer",
    });

    await expect(
      gate.evaluate(
        {
          kind: "subagent",
          parentSessionId: "parent-a",
          provider: "provider-a",
          sessionId: "child-c",
        },
        active.slice(0, 2),
      ),
    ).resolves.toEqual({ kind: "dispatch" });
  });

  it("makes subagents draw from the same WIP and provider budgets", async () => {
    const usage = new UsageStub({
      "provider-a": { used: 80, windowStartedAt: 1_000 },
    });
    const gate = new DispatchPacingGate(configuration(), usage, () => 2_000);
    const request = {
      kind: "subagent" as const,
      parentSessionId: "parent-a",
      provider: "provider-a",
      sessionId: "child-a",
    };

    await expect(
      gate.evaluate(request, [
        { depth: 0, provider: "provider-a", sessionId: "parent-a" },
        { depth: 0, provider: "provider-b", sessionId: "session-a" },
      ]),
    ).resolves.toMatchObject({
      deferral: { reason: "work-in-progress-limit" },
      kind: "defer",
    });
    await expect(
      gate.evaluate(request, [
        { depth: 0, provider: "provider-a", sessionId: "parent-a" },
      ]),
    ).resolves.toMatchObject({
      deferral: { reason: "provider-usage-window" },
      kind: "defer",
    });
  });

  it("allows an unbudgeted provider without consulting its usage source", async () => {
    const usage = new UsageStub({});
    const gate = new DispatchPacingGate(configuration(), usage, () => 2_000);

    await expect(
      gate.evaluate(
        {
          kind: "task",
          provider: "provider-b",
          sessionId: "session-a",
        },
        [],
      ),
    ).resolves.toEqual({ kind: "dispatch" });
    expect(usage.reads).toEqual([]);
  });

  it("derives depth only from an active parent session", async () => {
    const usage = new UsageStub({
      "provider-a": { used: 0, windowStartedAt: 1_000 },
    });
    const gate = new DispatchPacingGate(configuration(), usage, () => 2_000);
    const request = {
      kind: "subagent" as const,
      parentSessionId: "parent-a",
      provider: "provider-a",
      sessionId: "child-a",
    };

    await expect(gate.evaluate(request, [])).rejects.toThrow(
      "Active parent session parent-a is required",
    );
    await expect(
      gate.evaluate(request, [
        { depth: -1, provider: "provider-a", sessionId: "parent-a" },
      ]),
    ).rejects.toThrow("parent depth must be a non-negative safe integer");
  });
});
