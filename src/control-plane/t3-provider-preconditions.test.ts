// ---
// relationships:
//   verifies: heddle
//   references: t3-headless
// ---

import { describe, expect, it } from "vitest";

import {
  assertT3ProviderDispatchPreconditions,
  T3ProviderPreconditionError,
  type T3ProviderPreconditionReason,
} from "./t3-provider-preconditions.js";

const context = {
  cliVersion: null,
  driver: "new-driver",
  lifecycle: "independent" as const,
  providerInstanceId: "provider-alpha",
};

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
  it.each(["approval-required", "auto-accept-edits", "auto", "full-access"])(
    "allows exact T3 runtime mode %s for an open driver",
    (runtimeMode) => {
      expect(() =>
        assertT3ProviderDispatchPreconditions(
          context,
          runtimeMode,
          "provider-alpha",
        ),
      ).not.toThrow();
    },
  );

  it("does not use driver kind or observed CLI version as an allowlist", () => {
    expect(() =>
      assertT3ProviderDispatchPreconditions(
        {
          cliVersion: "unobserved-version",
          driver: "catalog-defined-driver",
          lifecycle: "assistive",
          providerInstanceId: "provider-beta",
        },
        "full-access",
        "provider-beta",
      ),
    ).not.toThrow();
  });

  it("requires provider context", () => {
    expectReason(
      () => assertT3ProviderDispatchPreconditions(undefined, "auto"),
      "provider-context-required",
    );
  });

  it("requires the selected provider instance to match its context", () => {
    expectReason(
      () =>
        assertT3ProviderDispatchPreconditions(context, "auto", "provider-beta"),
      "provider-instance-mismatch",
    );
  });

  it("rejects runtime modes outside T3's exact vocabulary", () => {
    expectReason(
      () =>
        assertT3ProviderDispatchPreconditions(
          context,
          "unrecognized-mode",
          "provider-alpha",
        ),
      "provider-runtime-mode-mismatch",
    );
  });
});
