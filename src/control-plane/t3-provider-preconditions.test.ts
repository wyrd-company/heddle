// ---
// relationships:
//   verifies: heddle
//   references: cursor-headless
// ---

import { describe, expect, it } from "vitest";

import {
  assertT3ProviderDispatchPreconditions,
  t3ProviderPreconditions,
  T3ProviderPreconditionError,
  type T3ProviderPreconditionReason,
  type T3ProviderPreconditionTable,
} from "./t3-provider-preconditions.js";

const expectReason = (
  operation: () => void,
  reason: T3ProviderPreconditionReason,
): void => {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(T3ProviderPreconditionError);
    expect(error).toMatchObject({ reason });
    return;
  }
  throw new Error(`Expected provider precondition '${reason}' to fail`);
};

describe("T3 provider dispatch preconditions", () => {
  it("uses the injected table instead of driver constants", () => {
    const table: T3ProviderPreconditionTable = {
      configurable: {
        "9.4.1": {
          runtimeModes: ["review-required", "unattended"],
          questionToolAvailable: true,
        },
      },
    };

    expect(() =>
      assertT3ProviderDispatchPreconditions(
        table,
        {
          driver: "configurable",
          cliVersion: "9.4.1",
          lifecycle: "assistive",
        },
        "unattended",
      ),
    ).not.toThrow();
  });

  it("keeps allowed runtime modes distinct by driver and CLI version", () => {
    expect(
      t3ProviderPreconditions["claudeAgent"]?.["2.1.250"]?.runtimeModes,
    ).toEqual(["auto-accept-edits"]);
    expect(
      t3ProviderPreconditions["cursor"]?.["2026.08.11-e8db854"]?.runtimeModes,
    ).toEqual(["auto"]);
    expect(
      t3ProviderPreconditions["cursor"]?.["2026.08.25-3e8eec8"]?.runtimeModes,
    ).toEqual(["auto", "full-access"]);
  });

  it.each(["auto", "full-access"])(
    "allows qualified Cursor mode %s",
    (runtimeMode) => {
      expect(() =>
        assertT3ProviderDispatchPreconditions(
          t3ProviderPreconditions,
          {
            driver: "cursor",
            cliVersion: "2026.08.25-3e8eec8",
            lifecycle: "independent",
          },
          runtimeMode,
        ),
      ).not.toThrow();
    },
  );

  it.each<{
    context:
      | {
          cliVersion: string;
          driver: string;
          lifecycle: "assistive" | "independent";
        }
      | undefined;
    reason: T3ProviderPreconditionReason;
    runtimeMode: string;
  }>([
    {
      context: undefined,
      runtimeMode: "auto",
      reason: "provider-context-required",
    },
    {
      context: {
        driver: "unconfigured",
        cliVersion: "1.0.0",
        lifecycle: "independent",
      },
      runtimeMode: "auto",
      reason: "provider-not-configured",
    },
    {
      context: {
        driver: "cursor",
        cliVersion: "2026.09.01-unknown",
        lifecycle: "independent",
      },
      runtimeMode: "auto",
      reason: "provider-cli-version-not-configured",
    },
    {
      context: {
        driver: "claudeAgent",
        cliVersion: "2.1.250",
        lifecycle: "independent",
      },
      runtimeMode: "auto",
      reason: "provider-runtime-mode-mismatch",
    },
    {
      context: {
        driver: "cursor",
        cliVersion: "2026.08.11-e8db854",
        lifecycle: "assistive",
      },
      runtimeMode: "auto",
      reason: "provider-question-tool-unavailable",
    },
  ])("rejects $reason", ({ context, reason, runtimeMode }) => {
    expectReason(
      () =>
        assertT3ProviderDispatchPreconditions(
          t3ProviderPreconditions,
          context,
          runtimeMode,
        ),
      reason,
    );
  });

  it("rejects full access for the earlier Cursor version", () => {
    expectReason(
      () =>
        assertT3ProviderDispatchPreconditions(
          t3ProviderPreconditions,
          {
            driver: "cursor",
            cliVersion: "2026.08.11-e8db854",
            lifecycle: "independent",
          },
          "full-access",
        ),
      "provider-runtime-mode-mismatch",
    );
  });

  it("rejects an unsupported mode for the qualified Cursor version", () => {
    expectReason(
      () =>
        assertT3ProviderDispatchPreconditions(
          t3ProviderPreconditions,
          {
            driver: "cursor",
            cliVersion: "2026.08.25-3e8eec8",
            lifecycle: "independent",
          },
          "approval-required",
        ),
      "provider-runtime-mode-mismatch",
    );
  });
});
