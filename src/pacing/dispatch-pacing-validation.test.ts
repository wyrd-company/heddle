// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import { DispatchPacingGate } from "./index.js";
import {
  configuration,
  UsageStub,
} from "./dispatch-pacing-gate.test-support.js";

describe("DispatchPacingGate validation", () => {
  it.each([
    [
      "empty default provider",
      configuration({ defaultProvider: " " }),
      "defaultProvider must not be empty",
    ],
    [
      "negative WIP limit",
      configuration({ maxConcurrentSessions: -1 }),
      "maxConcurrentSessions must be a non-negative safe integer",
    ],
    [
      "fractional WIP limit",
      configuration({ maxConcurrentSessions: 1.5 }),
      "maxConcurrentSessions must be a non-negative safe integer",
    ],
    [
      "unsafe WIP limit",
      configuration({ maxConcurrentSessions: 9_007_199_254_740_992 }),
      "maxConcurrentSessions must be a non-negative safe integer",
    ],
    [
      "wrong window length",
      { ...configuration(), usageWindowHours: 4 as 5 },
      "usageWindowHours must be 5",
    ],
    [
      "negative depth limit",
      configuration({ subagents: { maxDepth: -1, maxFanOut: 2 } }),
      "subagents.maxDepth must be a non-negative safe integer",
    ],
    [
      "unsafe depth limit",
      configuration({
        subagents: { maxDepth: 9_007_199_254_740_992, maxFanOut: 2 },
      }),
      "subagents.maxDepth must be a non-negative safe integer",
    ],
    [
      "fractional fan-out limit",
      configuration({ subagents: { maxDepth: 2, maxFanOut: 1.5 } }),
      "subagents.maxFanOut must be a non-negative safe integer",
    ],
    [
      "unsafe fan-out limit",
      configuration({
        subagents: { maxDepth: 2, maxFanOut: 9_007_199_254_740_992 },
      }),
      "subagents.maxFanOut must be a non-negative safe integer",
    ],
    [
      "empty provider identifier",
      configuration({ providerBudgets: { "": { usageLimit: 80 } } }),
      "provider must not be empty",
    ],
    [
      "negative provider limit",
      configuration({
        providerBudgets: { "provider-a": { usageLimit: -1 } },
      }),
      "providerBudgets.provider-a.usageLimit must be a non-negative finite number",
    ],
  ])("rejects %s configuration", (_name, invalid, message) => {
    expect(() => new DispatchPacingGate(invalid, new UsageStub({}))).toThrow(
      message,
    );
  });

  it.each([
    [
      "empty session identifier",
      { kind: "task" as const, provider: "provider-a", sessionId: " " },
      "sessionId must not be empty",
    ],
    [
      "empty provider identifier",
      { kind: "task" as const, provider: " ", sessionId: "session-a" },
      "provider must not be empty",
    ],
    [
      "empty parent identifier",
      {
        kind: "subagent" as const,
        parentSessionId: " ",
        provider: "provider-a",
        sessionId: "child-a",
      },
      "parentSessionId must not be empty",
    ],
  ])("rejects a request with an %s", async (_name, request, message) => {
    const gate = new DispatchPacingGate(configuration(), new UsageStub({}));

    await expect(gate.evaluate(request, [])).rejects.toThrow(message);
  });

  it("rejects invalid provider observations", async () => {
    const usage = new UsageStub({
      "provider-a": { used: -1, windowStartedAt: 1_000 },
    });
    const gate = new DispatchPacingGate(configuration(), usage, () => 2_000);
    await expect(
      gate.evaluate(
        {
          kind: "task",
          provider: "provider-a",
          sessionId: "session-a",
        },
        [],
      ),
    ).rejects.toThrow("provider-a usage must be a non-negative finite number");

    const invalidWindow = new DispatchPacingGate(
      configuration(),
      new UsageStub({
        "provider-a": { used: 1, windowStartedAt: -1 },
      }),
      () => 2_000,
    );
    await expect(
      invalidWindow.evaluate(
        {
          kind: "task",
          provider: "provider-a",
          sessionId: "session-a",
        },
        [],
      ),
    ).rejects.toThrow(
      "provider-a windowStartedAt must be a non-negative safe integer",
    );
  });

  it("rejects a provider window whose end is not a safe timestamp", async () => {
    const gate = new DispatchPacingGate(
      configuration(),
      new UsageStub({
        "provider-a": {
          used: 80,
          windowStartedAt: Number.MAX_SAFE_INTEGER,
        },
      }),
      () => 2_000,
    );

    await expect(
      gate.evaluate(
        {
          kind: "task",
          provider: "provider-a",
          sessionId: "session-a",
        },
        [],
      ),
    ).rejects.toThrow(
      "provider-a window end must be a non-negative safe integer",
    );
  });
});
